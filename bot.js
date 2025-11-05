# Project: mee6-lite-bot

This is a self-hosted, MEE6-like starter bot with core features:
- Leveling & XP with /rank and /leaderboard
- Welcome messages and optional auto-role on join
- Light automod (anti-invite for new members)
- Role menu via a drop-down selector
- Per-server config persisted in SQLite

Runs on Node 18+ with discord.js v14 and better-sqlite3. One-file bootable, no external services.

---

## 📁 File tree

```
mee6-lite-bot/
  package.json
  .env            # create from sample below
  bot.js
  README.md
```

---

## 📦 package.json
```json
{
  "name": "mee6-lite-bot",
  "version": "1.0.0",
  "type": "module",
  "main": "bot.js",
  "scripts": {
    "start": "node bot.js"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.0",
    "discord.js": "^14.15.3",
    "dotenv": "^16.4.5"
  }
}
```

---

## 🔐 .env (sample)
```env
DISCORD_TOKEN=YOUR_BOT_TOKEN
CLIENT_ID=YOUR_APPLICATION_CLIENT_ID
# Optional: set a DEV_GUILD_ID to register commands instantly for a single server during testing
DEV_GUILD_ID=
```

---

## 🚀 bot.js
```js
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import Database from 'better-sqlite3';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DEV_GUILD_ID = process.env.DEV_GUILD_ID || null;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

// --- DB setup ---
const DB_PATH = process.env.DB_PATH || '/data/mee6-lite.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.prepare(`CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  last_xp_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  welcome_channel_id TEXT,
  welcome_message TEXT,
  autorole_id TEXT,
  leveling_enabled INTEGER NOT NULL DEFAULT 1,
  log_channel_id TEXT
)`).run();

const getCfg = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?');
const upsertCfg = db.prepare(`INSERT INTO guild_config (guild_id, welcome_channel_id, welcome_message, autorole_id, leveling_enabled, log_channel_id)
VALUES (@guild_id, @welcome_channel_id, @welcome_message, @autorole_id, @leveling_enabled, @log_channel_id)
ON CONFLICT(guild_id) DO UPDATE SET
welcome_channel_id=excluded.welcome_channel_id,
welcome_message=excluded.welcome_message,
autorole_id=excluded.autorole_id,
leveling_enabled=excluded.leveling_enabled,
log_channel_id=excluded.log_channel_id`);

const getUser = db.prepare('SELECT * FROM users WHERE guild_id = ? AND user_id = ?');
const upsertUser = db.prepare(`INSERT INTO users (guild_id, user_id, xp, level, last_xp_ts)
VALUES (@guild_id, @user_id, @xp, @level, @last_xp_ts)
ON CONFLICT(guild_id, user_id) DO UPDATE SET xp=excluded.xp, level=excluded.level`);
const setLastXP = db.prepare('UPDATE users SET last_xp_ts = ? WHERE guild_id = ? AND user_id = ?');
const topUsers = db.prepare('SELECT user_id, xp, level FROM users WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT 10');

// --- Level math ---
function xpForNext(level) {
  // classic quadratic-ish curve
  return 5 * level * level + 50 * level + 100;
}

// --- Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// --- Commands ---
const commands = [
  {
    name: 'rank',
    description: 'Show your level and XP or someone else\'s',
    options: [
      { name: 'user', description: 'Target user', type: 6, required: false }
    ]
  },
  {
    name: 'leaderboard', description: 'Top 10 members by level'
  },
  {
    name: 'setwelcome', description: 'Set welcome message and channel',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      { name: 'channel', description: 'Welcome channel', type: 7, required: true },
      { name: 'message', description: 'Welcome text, supports {user} and {server}', type: 3, required: true }
    ]
  },
  {
    name: 'setautorole', description: 'Set an autorole to give on join',
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
    options: [
      { name: 'role', description: 'Role to assign', type: 8, required: true }
    ]
  },
  {
    name: 'toggleleveling', description: 'Enable/disable leveling',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      { name: 'enabled', description: 'true or false', type: 5, required: true }
    ]
  },
  {
    name: 'setlog', description: 'Set a log channel for bot events',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      { name: 'channel', description: 'Log channel', type: 7, required: true }
    ]
  },
  {
    name: 'rolemenu', description: 'Create a role menu with a dropdown (up to 5 roles)',
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
    options: [
      { name: 'title', description: 'Menu title', type: 3, required: true },
      { name: 'role1', description: 'Role mention 1', type: 8, required: true },
      { name: 'role2', description: 'Role mention 2', type: 8, required: false },
      { name: 'role3', description: 'Role mention 3', type: 8, required: false },
      { name: 'role4', description: 'Role mention 4', type: 8, required: false },
      { name: 'role5', description: 'Role mention 5', type: 8, required: false }
    ]
  }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (DEV_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID), { body: commands });
      console.log('Registered guild commands (dev)');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Registered global commands');
    }
  } catch (err) {
    console.error('Command register error:', err);
  }
}

// --- Interaction handling ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;

  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === 'rank') return handleRank(interaction);
      if (commandName === 'leaderboard') return handleLeaderboard(interaction);
      if (commandName === 'setwelcome') return handleSetWelcome(interaction);
      if (commandName === 'setautorole') return handleSetAutorole(interaction);
      if (commandName === 'toggleleveling') return handleToggleLeveling(interaction);
      if (commandName === 'setlog') return handleSetLog(interaction);
      if (commandName === 'rolemenu') return handleRoleMenu(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      if (!interaction.customId.startsWith('role_menu:')) return;
      const selected = interaction.values; // role IDs

      // remove all roles from the menu list, then add selected
      const roleIds = interaction.component.options.map(o => o.value);
      const member = await interaction.guild.members.fetch(interaction.user.id);

      // filter manageable roles
      const manageable = roleIds.filter(rid => interaction.guild.roles.cache.get(rid)?.editable);

      const toRemove = member.roles.cache.filter(r => manageable.includes(r.id));
      await member.roles.remove(toRemove);
      await member.roles.add(selected);

      await interaction.reply({ content: 'Your roles were updated.', ephemeral: true });
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: 'Something went wrong.', ephemeral: true }); } catch {}
    }
  }
});

// --- Command impls ---
async function handleRank(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const rec = getUser.get(interaction.guildId, user.id) || { xp: 0, level: 0 };
  const next = xpForNext(rec.level);
  const embed = new EmbedBuilder()
    .setTitle(`Level for ${user.username}`)
    .setDescription(`Level **${rec.level}**\nXP **${rec.xp}** / **${next}** to next level`)
    .setThumbnail(user.displayAvatarURL())
    .setColor(0x5865F2);
  await interaction.reply({ embeds: [embed] });
}

async function handleLeaderboard(interaction) {
  const rows = topUsers.all(interaction.guildId);
  if (!rows.length) return interaction.reply('No data yet. Start chatting!');
  const lines = await Promise.all(rows.map(async (r, i) => {
    const user = await interaction.client.users.fetch(r.user_id).catch(() => null);
    const name = user?.username || r.user_id;
    return `**${i + 1}.** ${name} — Lv ${r.level} (${r.xp} XP)`;
  }));
  await interaction.reply(lines.join('\n'));
}

async function handleSetWelcome(interaction) {
  const channel = interaction.options.getChannel('channel');
  const message = interaction.options.getString('message');
  upsertCfg.run({
    guild_id: interaction.guildId,
    welcome_channel_id: channel.id,
    welcome_message: message,
    autorole_id: getCfg.get(interaction.guildId)?.autorole_id || null,
    leveling_enabled: getCfg.get(interaction.guildId)?.leveling_enabled ?? 1,
    log_channel_id: getCfg.get(interaction.guildId)?.log_channel_id || null
  });
  await interaction.reply(`Welcome set. Channel: ${channel} Message: ${message}`);
}

async function handleSetAutorole(interaction) {
  const role = interaction.options.getRole('role');
  upsertCfg.run({
    guild_id: interaction.guildId,
    autorole_id: role.id,
    welcome_channel_id: getCfg.get(interaction.guildId)?.welcome_channel_id || null,
    welcome_message: getCfg.get(interaction.guildId)?.welcome_message || null,
    leveling_enabled: getCfg.get(interaction.guildId)?.leveling_enabled ?? 1,
    log_channel_id: getCfg.get(interaction.guildId)?.log_channel_id || null
  });
  await interaction.reply(`Autorole set to ${role}`);
}

async function handleToggleLeveling(interaction) {
  const enabled = interaction.options.getBoolean('enabled');
  upsertCfg.run({
    guild_id: interaction.guildId,
    leveling_enabled: enabled ? 1 : 0,
    welcome_channel_id: getCfg.get(interaction.guildId)?.welcome_channel_id || null,
    welcome_message: getCfg.get(interaction.guildId)?.welcome_message || null,
    autorole_id: getCfg.get(interaction.guildId)?.autorole_id || null,
    log_channel_id: getCfg.get(interaction.guildId)?.log_channel_id || null
  });
  await interaction.reply(`Leveling ${enabled ? 'enabled' : 'disabled'}.`);
}

async function handleSetLog(interaction) {
  const channel = interaction.options.getChannel('channel');
  upsertCfg.run({
    guild_id: interaction.guildId,
    log_channel_id: channel.id,
    welcome_channel_id: getCfg.get(interaction.guildId)?.welcome_channel_id || null,
    welcome_message: getCfg.get(interaction.guildId)?.welcome_message || null,
    autorole_id: getCfg.get(interaction.guildId)?.autorole_id || null,
    leveling_enabled: getCfg.get(interaction.guildId)?.leveling_enabled ?? 1
  });
  await interaction.reply(`Log channel set to ${channel}`);
}

async function handleRoleMenu(interaction) {
  const title = interaction.options.getString('title');
  const roleIds = ['role1','role2','role3','role4','role5']
    .map(n => interaction.options.getRole(n)?.id)
    .filter(Boolean);

  if (!roleIds.length) return interaction.reply({ content: 'You must include at least one role.', ephemeral: true });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('role_menu:' + Date.now())
    .setPlaceholder('Pick your roles')
    .setMinValues(0)
    .setMaxValues(roleIds.length)
    .addOptions(roleIds.map(rid => ({ label: interaction.guild.roles.cache.get(rid)?.name || rid, value: rid })));

  const row = new ActionRowBuilder().addComponents(menu);

  const embed = new EmbedBuilder().setTitle(title).setDescription('Select roles below').setColor(0x57F287);
  await interaction.reply({ embeds: [embed], components: [row] });
}

// --- Events ---
client.on('guildMemberAdd', async (member) => {
  const cfg = getCfg.get(member.guild.id);
  const log = cfg?.log_channel_id ? member.guild.channels.cache.get(cfg.log_channel_id) : null;

  // Autorole
  if (cfg?.autorole_id) {
    const role = member.guild.roles.cache.get(cfg.autorole_id);
    if (role && role.editable) {
      await member.roles.add(role).catch(() => {});
    }
  }

  // Welcome message
  const channelId = cfg?.welcome_channel_id || member.guild.systemChannelId;
  const channel = channelId ? member.guild.channels.cache.get(channelId) : null;
  const msgT = (cfg?.welcome_message || 'Welcome {user} to {server}!');
  const text = msgT.replaceAll('{user}', `<@${member.id}>`).replaceAll('{server}', member.guild.name);
  if (channel?.isTextBased()) channel.send({ content: text }).catch(() => {});
  if (log?.isTextBased()) log.send(`New member joined: ${member.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  // Light automod: block invite links from members newer than 7 days and without ManageMessages
  const isInvite = /(discord\.gg\/|discord\.com\/invite\/)/i.test(message.content);
  if (isInvite) {
    const member = message.member;
    const joinedAgoMs = Date.now() - member.joinedTimestamp;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    if (joinedAgoMs < sevenDays && !member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await message.delete().catch(() => {});
      await message.channel.send({ content: `${member}, invite links aren\'t allowed for new members.` }).catch(() => {});
      const cfg = getCfg.get(message.guild.id);
      const log = cfg?.log_channel_id ? message.guild.channels.cache.get(cfg.log_channel_id) : null;
      if (log?.isTextBased()) log.send(`Deleted invite link from ${member.user.tag} in ${message.channel}`);
      return;
    }
  }

  // Leveling
  const cfg = getCfg.get(message.guild.id);
  if (!cfg || cfg.leveling_enabled !== 1) return;

  const now = Date.now();
  const rec = getUser.get(message.guild.id, message.author.id) || { guild_id: message.guild.id, user_id: message.author.id, xp: 0, level: 0, last_xp_ts: 0 };
  const cooldownMs = 60 * 1000; // 1 minute
  if (now - rec.last_xp_ts < cooldownMs) return;

  const gain = 15 + Math.floor(Math.random() * 11); // 15-25 XP
  let newXP = (rec.xp || 0) + gain;
  let level = rec.level || 0;
  let next = xpForNext(level);

  let leveledUp = false;
  while (newXP >= next) {
    newXP -= next;
    level += 1;
    next = xpForNext(level);
    leveledUp = true;
  }

  upsertUser.run({ guild_id: message.guild.id, user_id: message.author.id, xp: newXP, level, last_xp_ts: rec.last_xp_ts });
  setLastXP.run(now, message.guild.id, message.author.id);

  if (leveledUp) {
    message.channel.send({ content: `${message.author} leveled up to **${level}**!` }).catch(() => {});
  }
});

client.login(TOKEN);
```

---

## 🧭 Quick setup

1) Create a Discord application at <https://discord.com/developers/applications>.
2) Add a Bot user. Copy the token into `.env` as `DISCORD_TOKEN`.
3) Copy your Application ID into `.env` as `CLIENT_ID`.
4) During testing, set `DEV_GUILD_ID` to your server ID for instant command registration.
5) Invite the bot with necessary scopes: `bot applications.commands` and permissions: Manage Roles, Manage Messages, Read/Send Messages.
6) `npm i` then `npm start`.
7) In your server, run:
   - `/setwelcome #channel Welcome {user} to {server}! Read the rules.`
   - `/setautorole @Member`
   - `/setlog #mod-log`
   - `/rolemenu title:"Pick your roles" role1:@Pings role2:@Events`

Tip: once you’re happy, clear `DEV_GUILD_ID` and restart to push global commands.

---

## 🧩 What to customize next
- **Role rewards**: give roles at certain levels (add a `level_rewards` table, listen for level-up, assign role).
- **XP boosters**: more XP in specific channels or time windows.
- **Weekly digest**: count messages per channel/user and post Sunday.
- **Tickets**: add `/ticket` to open private threads for support.
- **Web dashboard**: expose config with a small Express app + OAuth2.

---

## 🛟 Safety & notes
- Make sure the bot’s role is above any roles it needs to assign.
- Least-privilege: if you don’t need Manage Messages, remove it from the invite.
- Back up `mee6-lite.db` if you care about your XP history.

---

## 📘 README.md
```
Mee6-lite Bot
==============
A compact, self-hosted Discord bot with leveling, welcome, light automod, and role menus. No external DB required.

Commands:
- /rank [user]
- /leaderboard
- /setwelcome channel:<#> message:<text>
- /setautorole role:<@>
- /toggleleveling enabled:<true|false>
- /setlog channel:<#>
- /rolemenu title:<text> role1..role5:<@>

Environment:
DISCORD_TOKEN=...
CLIENT_ID=...
DEV_GUILD_ID=... # optional
DB_PATH=/data/mee6-lite.db # for Railway volume persistence

Run:
- npm i
- npm start
```

---

## 🧰 railway.json (optional, for 1‑click deploy)
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm start"
  },
  "services": [
    {
      "name": "nivyn-bot",
      "volumes": [
        {
          "name": "bot-data",
          "mountPath": "/data",
          "sizeGB": 1
        }
      ]
    }
  ]
}
```

---

## 🔐 .env.example
```
DISCORD_TOKEN=
CLIENT_ID=
DEV_GUILD_ID=
DB_PATH=/data/mee6-lite.db
```
