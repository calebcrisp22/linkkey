import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

const { Pool } = pg;

const token = process.env.DISCORD_BOT_TOKEN?.trim();
const ownerId = process.env.DISCORD_OWNER_ID?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
const port = Number(process.env.PORT || 8080);

if (!token || !ownerId || !databaseUrl) {
  throw new Error(
    "DATABASE_URL, DISCORD_BOT_TOKEN, and DISCORD_OWNER_ID are required.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let status = { state: "starting" };

const commands = [
  new SlashCommandBuilder()
    .setName("key-create")
    .setDescription("Create one or more single-use digital keys")
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Credits each key adds")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(1000000),
    )
    .addIntegerOption((option) =>
      option
        .setName("quantity")
        .setDescription("How many keys to create")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("Optional internal note")
        .setRequired(false)
        .setMaxLength(200),
    ),
  new SlashCommandBuilder()
    .setName("redeem-for")
    .setDescription("Redeem a key into another user's balance")
    .addUserOption((option) =>
      option.setName("user").setDescription("The recipient").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("key")
        .setDescription("The single-use digital key")
        .setRequired(true)
        .setMaxLength(64),
    ),
  new SlashCommandBuilder()
    .setName("balance-add")
    .setDescription("Add or subtract credits from a user's balance")
    .addUserOption((option) =>
      option.setName("user").setDescription("The user").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Use a negative number to subtract")
        .setRequired(true)
        .setMinValue(-1000000)
        .setMaxValue(1000000),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("Why this adjustment was made")
        .setRequired(false)
        .setMaxLength(200),
    ),
  new SlashCommandBuilder()
    .setName("balance-set")
    .setDescription("Set a user's balance to an exact amount")
    .addUserOption((option) =>
      option.setName("user").setDescription("The user").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("New balance")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(1000000000),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("Why this balance was set")
        .setRequired(false)
        .setMaxLength(200),
    ),
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("View a user's current balance")
    .addUserOption((option) =>
      option.setName("user").setDescription("The user").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("key-status")
    .setDescription("Check whether a digital key is unused or redeemed")
    .addStringOption((option) =>
      option
        .setName("key")
        .setDescription("The digital key")
        .setRequired(true)
        .setMaxLength(64),
    ),
  new SlashCommandBuilder()
    .setName("ledger")
    .setDescription("View recent balance activity for a user")
    .addUserOption((option) =>
      option.setName("user").setDescription("The user").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription("Number of entries to show")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10),
    ),
].map((command) => command.toJSON());

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS digital_keys (
      id BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      amount INTEGER NOT NULL CHECK (amount > 0),
      note TEXT,
      created_by TEXT NOT NULL,
      claimed_by TEXT,
      redeemed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS balances (
      discord_user_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS balance_transactions (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      type TEXT NOT NULL,
      note TEXT,
      actor_user_id TEXT NOT NULL,
      key_id BIGINT REFERENCES digital_keys(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS balance_transactions_user_date_idx
      ON balance_transactions (discord_user_id, created_at DESC);
  `);
}

function log(message, details = "") {
  console.info(`[digital-key-bot] ${message}${details ? ` ${details}` : ""}`);
}

function normalizeKey(value) {
  return value.trim().toUpperCase();
}

function formatUser(user) {
  return `<@${user.id}> (${user.username})`;
}

function isOwner(interaction) {
  return interaction.user.id === ownerId;
}

function makeKey() {
  const segments = Array.from({ length: 3 }, () =>
    randomBytes(3).toString("hex").toUpperCase(),
  );
  return `DK-${segments.join("-")}`;
}

async function createKeys(interaction) {
  const amount = interaction.options.getInteger("amount", true);
  const quantity = interaction.options.getInteger("quantity") ?? 1;
  const note = interaction.options.getString("note")?.trim() || null;
  const keys = [];

  for (let index = 0; index < quantity; index += 1) {
    let key = makeKey();
    while ((await pool.query("SELECT 1 FROM digital_keys WHERE key = $1", [key])).rowCount) {
      key = makeKey();
    }
    await pool.query(
      "INSERT INTO digital_keys (key, amount, note, created_by) VALUES ($1, $2, $3, $4)",
      [key, amount, note, interaction.user.id],
    );
    keys.push(key);
  }

  await interaction.reply({
    content: [
      `Created ${keys.length} key${keys.length === 1 ? "" : "s"} worth **${amount.toLocaleString()} credits** each.`,
      "```",
      keys.join("\n"),
      "```",
      note ? `Note: ${note}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    ephemeral: true,
  });
}

async function redeemFor(interaction) {
  const recipient = interaction.options.getUser("user", true);
  const keyValue = normalizeKey(interaction.options.getString("key", true));
  const dbClient = await pool.connect();

  try {
    await dbClient.query("BEGIN");
    const keyResult = await dbClient.query(
      "SELECT id, amount, note FROM digital_keys WHERE key = $1 AND redeemed_at IS NULL FOR UPDATE",
      [keyValue],
    );
    const key = keyResult.rows[0];

    if (!key) {
      await dbClient.query("ROLLBACK");
      await interaction.reply({
        content: "That key is invalid or has already been redeemed.",
        ephemeral: true,
      });
      return;
    }

    const balanceResult = await dbClient.query(
      "SELECT balance FROM balances WHERE discord_user_id = $1 FOR UPDATE",
      [recipient.id],
    );
    const previousBalance = Number(balanceResult.rows[0]?.balance ?? 0);
    const newBalance = previousBalance + Number(key.amount);

    await dbClient.query(
      "UPDATE digital_keys SET claimed_by = $1, redeemed_at = NOW() WHERE id = $2",
      [recipient.id, key.id],
    );
    await dbClient.query(
      `INSERT INTO balances (discord_user_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (discord_user_id)
       DO UPDATE SET balance = EXCLUDED.balance, updated_at = NOW()`,
      [recipient.id, newBalance],
    );
    await dbClient.query(
      `INSERT INTO balance_transactions
       (discord_user_id, amount, balance_after, type, note, actor_user_id, key_id)
       VALUES ($1, $2, $3, 'key_redemption', $4, $5, $6)`,
      [recipient.id, key.amount, newBalance, key.note, interaction.user.id, key.id],
    );
    await dbClient.query("COMMIT");

    await interaction.reply({
      content: `Redeemed **${Number(key.amount).toLocaleString()} credits** to ${formatUser(recipient)}. New balance: **${newBalance.toLocaleString()}**.`,
      ephemeral: true,
    });
  } catch (error) {
    await dbClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    dbClient.release();
  }
}

async function adjustBalance(interaction) {
  const recipient = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const note = interaction.options.getString("note")?.trim() || null;
  const dbClient = await pool.connect();

  try {
    await dbClient.query("BEGIN");
    const current = await dbClient.query(
      "SELECT balance FROM balances WHERE discord_user_id = $1 FOR UPDATE",
      [recipient.id],
    );
    const previousBalance = Number(current.rows[0]?.balance ?? 0);
    const newBalance = previousBalance + amount;

    if (newBalance < 0) {
      await dbClient.query("ROLLBACK");
      await interaction.reply({
        content: "That adjustment would make the balance negative, so it was not applied.",
        ephemeral: true,
      });
      return;
    }

    await dbClient.query(
      `INSERT INTO balances (discord_user_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (discord_user_id)
       DO UPDATE SET balance = EXCLUDED.balance, updated_at = NOW()`,
      [recipient.id, newBalance],
    );
    await dbClient.query(
      `INSERT INTO balance_transactions
       (discord_user_id, amount, balance_after, type, note, actor_user_id)
       VALUES ($1, $2, $3, 'manual_adjustment', $4, $5)`,
      [recipient.id, amount, newBalance, note, interaction.user.id],
    );
    await dbClient.query("COMMIT");

    await interaction.reply({
      content: `Updated ${formatUser(recipient)} by **${amount >= 0 ? "+" : ""}${amount.toLocaleString()}**. New balance: **${newBalance.toLocaleString()}**.`,
      ephemeral: true,
    });
  } catch (error) {
    await dbClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    dbClient.release();
  }
}

async function setBalance(interaction) {
  const recipient = interaction.options.getUser("user", true);
  const amount = interaction.options.getInteger("amount", true);
  const note = interaction.options.getString("note")?.trim() || null;
  const dbClient = await pool.connect();

  try {
    await dbClient.query("BEGIN");
    const current = await dbClient.query(
      "SELECT balance FROM balances WHERE discord_user_id = $1 FOR UPDATE",
      [recipient.id],
    );
    const previousBalance = Number(current.rows[0]?.balance ?? 0);
    await dbClient.query(
      `INSERT INTO balances (discord_user_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (discord_user_id)
       DO UPDATE SET balance = EXCLUDED.balance, updated_at = NOW()`,
      [recipient.id, amount],
    );
    await dbClient.query(
      `INSERT INTO balance_transactions
       (discord_user_id, amount, balance_after, type, note, actor_user_id)
       VALUES ($1, $2, $3, 'manual_set', $4, $5)`,
      [recipient.id, amount - previousBalance, amount, note, interaction.user.id],
    );
    await dbClient.query("COMMIT");

    await interaction.reply({
      content: `Set ${formatUser(recipient)} to **${amount.toLocaleString()}** credits (was ${previousBalance.toLocaleString()}).`,
      ephemeral: true,
    });
  } catch (error) {
    await dbClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    dbClient.release();
  }
}

async function showBalance(interaction) {
  const recipient = interaction.options.getUser("user", true);
  const result = await pool.query(
    "SELECT balance FROM balances WHERE discord_user_id = $1",
    [recipient.id],
  );
  const balance = Number(result.rows[0]?.balance ?? 0);
  await interaction.reply({
    content: `${formatUser(recipient)} has **${balance.toLocaleString()} credits**.`,
    ephemeral: true,
  });
}

async function showKeyStatus(interaction) {
  const keyValue = normalizeKey(interaction.options.getString("key", true));
  const result = await pool.query(
    "SELECT key, amount, claimed_by, redeemed_at FROM digital_keys WHERE key = $1",
    [keyValue],
  );
  const key = result.rows[0];

  if (!key) {
    await interaction.reply({
      content: "No key with that code exists.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: key.redeemed_at
      ? `**${key.key}** was redeemed for <@${key.claimed_by}> on ${new Date(key.redeemed_at).toISOString()}.`
      : `**${key.key}** is unused and worth **${Number(key.amount).toLocaleString()} credits**.`,
    ephemeral: true,
  });
}

async function showLedger(interaction) {
  const recipient = interaction.options.getUser("user", true);
  const limit = interaction.options.getInteger("limit") ?? 5;
  const result = await pool.query(
    `SELECT created_at, type, amount, balance_after, note
     FROM balance_transactions
     WHERE discord_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [recipient.id, limit],
  );

  if (result.rows.length === 0) {
    await interaction.reply({ content: "No balance activity yet.", ephemeral: true });
    return;
  }

  const lines = result.rows.map((entry) => {
    const date = new Date(entry.created_at).toISOString().slice(0, 16).replace("T", " ");
    const note = entry.note ? ` | ${String(entry.note).slice(0, 60)}` : "";
    const sign = Number(entry.amount) >= 0 ? "+" : "";
    return `${date} | ${entry.type} | ${sign}${entry.amount} | balance ${entry.balance_after}${note}`;
  });

  await interaction.reply({
    content: [`Recent activity for ${formatUser(recipient)}:`, "```", ...lines, "```"].join("\n"),
    ephemeral: true,
  });
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (!isOwner(interaction)) {
    await interaction.reply({
      content: "This bot is private. Only its configured owner can run commands.",
      ephemeral: true,
    });
    return;
  }

  try {
    switch (interaction.commandName) {
      case "key-create":
        await createKeys(interaction);
        break;
      case "redeem-for":
        await redeemFor(interaction);
        break;
      case "balance-add":
        await adjustBalance(interaction);
        break;
      case "balance-set":
        await setBalance(interaction);
        break;
      case "balance":
        await showBalance(interaction);
        break;
      case "key-status":
        await showKeyStatus(interaction);
        break;
      case "ledger":
        await showLedger(interaction);
        break;
      default:
        await interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  } catch (error) {
    console.error("[digital-key-bot] command failed", error);
    const content = "Something went wrong while processing that command.";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }
}

async function registerCommands(applicationId) {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(applicationId), { body: commands });
}

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await registerCommands(readyClient.user.id);
    status = {
      state: "online",
      userTag: readyClient.user.tag,
      userId: readyClient.user.id,
      ownerConfigured: true,
    };
    log(`online as ${readyClient.user.tag}`);
  } catch (error) {
    status = {
      state: "error",
      error: error instanceof Error ? error.message : "Command registration failed",
    };
    console.error("[digital-key-bot] command registration failed", error);
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  void handleInteraction(interaction);
});

client.on(Events.Error, (error) => {
  status = {
    state: "error",
    error: error instanceof Error ? error.message : "Discord client error",
  };
  console.error("[digital-key-bot] Discord client error", error);
});

const httpServer = createServer((request, response) => {
  if (request.url === "/healthz" || request.url === "/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(status));
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});

async function start() {
  await initializeDatabase();
  httpServer.listen(port, "0.0.0.0", () => log(`health server listening on ${port}`));
  await client.login(token);
}

async function shutdown(signal) {
  log(`received ${signal}; shutting down`);
  client.destroy();
  await pool.end();
  httpServer.close(() => process.exit(0));
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

start().catch((error) => {
  status = {
    state: "error",
    error: error instanceof Error ? error.message : "Startup failed",
  };
  console.error("[digital-key-bot] startup failed", error);
  process.exit(1);
});