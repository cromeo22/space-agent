import { createGuestUser } from "../lib/auth/manage-users.js";

export const allowAnonymous = true;

// TODO: Move guest-account availability behind explicit server configuration
// once guest mode becomes optional and policy-driven.

export async function post(context) {
  const guestAccount = createGuestUser(context.projectRoot);

  if (context.watchdog && typeof context.watchdog.refresh === "function") {
    await context.watchdog.refresh();
  }

  return {
    headers: {
      "Cache-Control": "no-store"
    },
    status: 200,
    body: {
      password: guestAccount.password,
      username: guestAccount.username
    }
  };
}
