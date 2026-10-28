// Optional PostHog analytics. Everything here is a no-op unless POSTHOG_KEY
// is set. Events carry counts and amounts only, never student names, parent
// names or phone numbers.
const { PostHog } = require('posthog-node');

const KEY = process.env.POSTHOG_KEY || '';
const HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

const client = KEY ? new PostHog(KEY, { host: HOST, flushAt: 20, flushInterval: 10000 }) : null;

if (client) {
  // Send anything still queued when the service stops or restarts.
  const flush = () => client.shutdown().finally(() => process.exit(0));
  process.once('SIGTERM', flush);
  process.once('SIGINT', flush);
}

// The same id the browser uses in posthog.identify(), so server and browser
// events land on one person.
const distinctId = (user) => `user-${user.id}`;

function track(user, event, properties = {}) {
  if (!client || !user) return;
  try {
    client.capture({
      distinctId: distinctId(user),
      event,
      properties: { ...properties, role: user.role, $process_person_profile: true },
    });
  } catch (err) {
    console.error('PostHog capture failed:', err.message);
  }
}

// Settings for the browser snippet (rendered into the page footer).
const browserConfig = KEY ? { key: KEY, host: HOST } : null;

module.exports = { track, distinctId, browserConfig };
