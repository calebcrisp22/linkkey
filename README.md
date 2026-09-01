# Discord Digital Key Bot

This folder is the complete bot package for GitHub and Railway. It intentionally contains only the files required to run the bot.

## Railway variables

Add these three required variables:

```text
DATABASE_URL
DISCORD_BOT_TOKEN
DISCORD_OWNER_ID
```

Railway provides `PORT` automatically. Do not add it manually.

For `DATABASE_URL`, add a Railway PostgreSQL service and reference its connection string, commonly:

```text
${{Postgres.DATABASE_URL}}
```

Replace `Postgres` with the exact name of your database service.

## Railway setup

1. Upload this folder to a new GitHub repository.
2. Create a Railway project from that repository.
3. Add a PostgreSQL service.
4. Add the three variables above to the bot service.
5. Use this start command:

```bash
npm start
```

The bot creates its own PostgreSQL tables when it starts. No migration command is needed.

## Discord commands

Every command is restricted to `DISCORD_OWNER_ID`. Other users receive a private denial message.

- `/key-create amount quantity note`
- `/redeem-for user key`
- `/balance-add user amount note`
- `/balance-set user amount note`
- `/balance user`
- `/key-status key`
- `/ledger user limit`

The bot registers the slash commands automatically after it logs in. Global Discord commands can take a few minutes to appear.

Invite the bot with the `bot` and `applications.commands` scopes.