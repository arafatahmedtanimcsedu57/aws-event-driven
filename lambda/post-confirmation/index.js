// Cognito Post Confirmation trigger. Fires after a user confirms signup.
// Inserts the new user into the RDS `customers` table.
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secrets = new SecretsManagerClient({});
let cachedCreds = null;   // cache across warm invocations so we don't re-fetch every time

async function getDbCreds() {
  if (cachedCreds) return cachedCreds;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
  cachedCreds = JSON.parse(res.SecretString);   // { username, password, host, port, dbname, ... }
  return cachedCreds;
}

exports.handler = async (event) => {
  // Cognito passes the user's attributes in event.request.userAttributes
  const attrs = event.request.userAttributes;
  const sub = attrs.sub;
  const email = attrs.email;

  console.log(JSON.stringify({ event: 'postConfirmation', sub }));

  if (!email) {
    console.error(JSON.stringify({ event: 'insertSkipped', sub, reason: 'missing email attribute' }));
    return event;
  }

  // Everything below is best-effort: a failed profile write must never block
  // signup, so every failure here — including fetching credentials and closing
  // the connection — is caught and swallowed rather than thrown.
  let client;
  try {
    const creds = await getDbCreds();
    client = new Client({
      host: process.env.DB_HOST,
      port: 5432,
      user: creds.username,
      password: creds.password,
      database: process.env.DB_NAME,
      connectionTimeoutMillis: 5000,
      ssl: { rejectUnauthorized: false },   // RDS requires SSL; relaxed check for learning
    });
    await client.connect();

    try {
      // create the table on first run (idempotent); a concurrent first run can
      // lose this race with a duplicate_table error (42P07) — ignore just that
      await client.query(`
        CREATE TABLE IF NOT EXISTS customers (
          sub        TEXT PRIMARY KEY,
          email      TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `);
    } catch (err) {
      if (err.code !== '42P07') throw err;
    }

    await client.query(
      `INSERT INTO customers (sub, email) VALUES ($1, $2)
       ON CONFLICT (sub) DO NOTHING`,   // don't fail if the user already exists
      [sub, email]
    );
    console.log(JSON.stringify({ event: 'customerInserted', sub }));
  } catch (err) {
    console.error(JSON.stringify({ event: 'insertFailed', sub, error: err.message }));
  } finally {
    if (client) {
      await client.end().catch((err) =>
        console.error(JSON.stringify({ event: 'connectionCloseFailed', sub, error: err.message }))
      );
    }
  }

  // Cognito triggers MUST return the event object unchanged to complete the flow
  return event;
};