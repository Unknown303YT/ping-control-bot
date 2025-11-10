import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createServer } from "http";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
  partials: [Partials.Channel]
});

// 🏷️ Role names — must match your server exactly
const NO_PING_ROLE = "No Ping";
const CAN_PING_IF_ONLINE_ROLE = "Ping If Online";
const MOD_BYPASS_ROLE = "Cool++"; // Mods won't have their pings restricted

client.on("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (message.mentions.users.size === 0) return;

  const guild = message.guild;
  const memberAuthor = await guild.members.fetch(message.author.id).catch(() => null);
  if (!memberAuthor) return;

  // 🔒 Skip restrictions if author has the mod role
  if (memberAuthor.roles.cache.some(r => r.name === MOD_BYPASS_ROLE)) {
    return;
  }

  const mentions = message.mentions.users;
  let modified = false;
  let newContent = message.content;
  const blockedUsers = [];

  for (const [, user] of mentions) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) continue;

    // Check if @everyone or @here is mentioned
    if (message.mentions.everyone || message.mentions.here) {
      // Only block if the sender is not a mod
      if (!memberAuthor.roles.cache.some(r => r.name === MOD_BYPASS_ROLE)) {
        // Replace actual ping with plain text so it doesn’t notify anyone
        newContent = newContent.replace(/@everyone/g, "@everyone").replace(/@here/g, "@here");
        modified = true;
        blockedUsers.push("@everyone / @here");
      }
    }

    // 🚫 Rule 1: No Pinging — never allow pings
    if (member.roles.cache.some(r => r.name === NO_PING_ROLE)) {
      newContent = newContent.replace(
        new RegExp(`<@!?${user.id}>`, "g"),
        `@${user.username}`
      );
      modified = true;
      blockedUsers.push(`${user.username} (No Pinging)`);
      continue;
    }

    // ⚠️ Rule 2: Can Ping If Online — block if offline/idle/DND
    if (member.roles.cache.some(r => r.name === CAN_PING_IF_ONLINE_ROLE)) {
      const status = member.presence?.status || "offline";
      if (status !== "online") {
        newContent = newContent.replace(
          new RegExp(`<@!?${user.id}>`, "g"),
          `@${user.username}`
        );
        modified = true;
        blockedUsers.push(`${user.username} (not online)`);
      }
    }
  }

  if (modified) {
    // ✏️ Edit original message to remove pings
    await message.edit({
      content: newContent,
      allowedMentions: { parse: [] }
    }).catch(() => {});

    // 📩 DM the author privately
    try {
      const reasonList = blockedUsers.join(", ");
      const dmMsg = `⚠️ Hey ${message.author.username}! Your message has been modified to not ping ${reasonList} in **${guild.name}**.\n\nThose users either have their settings set to "No Ping" or "Ping if Online" but they are not online right now.`;
      await message.author.send(dmMsg);
    } catch (err) {
      console.log(`❌ Could not DM ${message.author.username}: ${err.message}`);
    }
  }
});

client.login(process.env.BOT_TOKEN || "YOUR_BOT_TOKEN");

const port = process.env.PORT || 3000;
createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running!");
}).listen(port, () => {
  console.log(`🌐 Web server running on port ${port}`);
});
