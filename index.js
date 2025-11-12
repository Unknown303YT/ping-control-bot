import { Client, GatewayIntentBits, Partials, SlashCommandBuilder, REST, Routes } from "discord.js";
import { createServer } from "http";
import { createClient } from '@supabase/supabase-js'

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

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
  const commands = [setRolesCommand.toJSON()];

  try {
    console.log("🌀 Registering slash commands...");
    await rest.put(
      // 👇 replace with your own IDs
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("✅ Slash commands registered!");
  } catch (error) {
    console.error("❌ Error registering commands:", error);
  }
}

await registerCommands();

// Save role config
export async function saveGuildConfig(guildId, roleType, roleName) {
  const { error } = await supabase
    .from("guild_config")
    .upsert({ guild_id: guildId, role_type: roleType, role_name: roleName });

  if (error) console.error("Supabase save error:", error);
}

// Fetch role config
export async function getGuildConfig(guildId) {
  const { data, error } = await supabase
    .from("guild_config")
    .select("*")
    .eq("guild_id", guildId);

  if (error) {
    console.error("Supabase fetch error:", error);
    return {};
  }

  const config = {};
  data.forEach(row => {
    config[row.role_type] = row.role_name;
  });
  return config;
}

const setRolesCommand = new SlashCommandBuilder()
  .setName("setroles")
  .setDescription("Configure role names for this server")
  .addStringOption(option =>
    option.setName("role_type")
      .setDescription("Which role type to configure")
      .setRequired(true)
      .addChoices(
        { name: "No Ping", value: "NO_PING_ROLE" },
        { name: "Ping If Online", value: "CAN_PING_IF_ONLINE_ROLE" },
        { name: "Mod Bypass", value: "MOD_BYPASS_ROLE" }
      )
  )
  .addRoleOption(option =>
    option.setName("role")
      .setDescription("Select a role from this server")
      .setRequired(true)
  );

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "setroles") {
    const roleType = interaction.options.getString("role_type");
    const role = interaction.options.getRole("role");

    await saveGuildConfig(interaction.guild.id, roleType, role.name);

    await interaction.reply(`✅ Set ${roleType} to **${role.name}** for this server.`);
  }
});

client.on("clientReady", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (message.mentions.users.size === 0) return;

  const guild = message.guild;
  const memberAuthor = await guild.members.fetch(message.author.id).catch(() => null);
  if (!memberAuthor) return;

  // Load config for this guild
  const config = await getGuildConfig(message.guild.id);

  // Fallbacks if no config set yet
  const NO_PING_ROLE = config.NO_PING_ROLE || "No Ping";
  const CAN_PING_IF_ONLINE_ROLE = config.CAN_PING_IF_ONLINE_ROLE || "Ping If Online";
  const MOD_BYPASS_ROLE = config.MOD_BYPASS_ROLE || "Moderator";

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
        `@${member.displayName}`
      );
      modified = true;
      blockedUsers.push(`${member.displayName} (No Pinging)`);
      continue;
    }

    // ⚠️ Rule 2: Can Ping If Online — block if offline/idle/DND
    if (member.roles.cache.some(r => r.name === CAN_PING_IF_ONLINE_ROLE)) {
      const status = member.presence?.status || "offline";
      if (status !== "online") {
        newContent = newContent.replace(
          new RegExp(`<@!?${user.id}>`, "g"),
          `@${member.displayName}`
        );
        modified = true;
        blockedUsers.push(`${member.displayName} (Ping if Online)`);
      }
    }
  }

  if (modified) {
    try {
      // Delete the original message
      await message.delete();

      // Repost modified content
      await message.channel.send({
        content: newContent + `\n⚠️ Edited to remove pings for restricted users. (originally by ${message.author})`,
        allowedMentions: { parse: [] } // prevents accidental pings
      });
    } catch (err) {
      console.log("Failed to delete/repost message:", err);
    }

    // 📩 DM the author privately
    try {
      const reasonList = blockedUsers.join(", ");
      const dmMsg = `⚠️ Hey ${message.author.username}! Your message has been modified to not ping ${reasonList} in **${guild.name}**.\n\nThose users either have their settings set to "No Ping" or they are set to "Ping if Online" and are not online right now.`;
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
