#!/usr/bin/env node
// GIT_ASKPASS target for the credential-retry path in server.js — git execs
// this directly (it must be a bare, argument-less path; see server.js's
// module comment on why credentials can't just be appended to GIT_ASKPASS
// itself) and passes the prompt text ("Username for '...':" / "Password
// for '...':") as argv[2]. Reads the actual values from this process's own
// env, which server.js sets only for the single retry request that
// supplied them — never persisted to disk, never embedded in the remote
// URL.
const prompt = process.argv[2] || "";
if (/username/i.test(prompt)) {
  process.stdout.write(`${process.env.GIT_SCM_ASKPASS_USERNAME || ""}\n`);
} else if (/password/i.test(prompt)) {
  process.stdout.write(`${process.env.GIT_SCM_ASKPASS_PASSWORD || ""}\n`);
} else {
  process.stdout.write("\n");
}
