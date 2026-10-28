import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { childEnv, redact, runShell } from "../src/index.ts";

test("redact: known token formats and credential assignments are masked; names and harmless values survive", () => {
  const fakes = ["sk-" + "a".repeat(40), "sk-ant-api03-" + "b".repeat(40), "ghp_" + "c".repeat(36), "AKIA" + "D".repeat(16), "xoxb-123456789012-abcdefghij", "AIza" + "e".repeat(35), "npm_" + "f".repeat(36), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"];
  for (const k of fakes) { const r = redact(`here: ${k} end`); assert.ok(!r.text.includes(k.slice(8)) && r.count === 1 && /\[REDACTED:/.test(r.text), k); }
  assert.match(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----").text, /^\[REDACTED:private-key\]$/);
  const env = redact('DB_PASSWORD=hunter2hunter2\nexport API_KEY="abcd1234efgh"\n{"client_secret": "zzzz9999yyyy"}\nAuthorization: Bearer abcdefghijklmnop1234');
  assert.ok(!/hunter2hunter2|abcd1234efgh|zzzz9999yyyy|abcdefghijklmnop1234/.test(env.text)); assert.match(env.text, /DB_PASSWORD=\[REDACTED:credential\]/); assert.match(env.text, /"client_secret": "\[REDACTED:credential\]"/); assert.equal(env.count, 4);
  const fine = "password: ${DB_PASSWORD}\ntoken = process.env.TOKEN\napi_key = os.environ['K']\nsecret: <your-secret>\npassword=true\nconst tokenizer = new Tokenizer();\nsk-short";
  assert.equal(redact(fine).count, 0); assert.equal(redact(fine).text, fine);
});

test("childEnv: Amness's own keys never reach commands; strict mode also drops credential-looking variables", async () => {
  const env = { PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "y", AMNESS_OTLP: "http://c", NPM_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", SSH_AUTH_SOCK: "/sock", DB_PASSWORD: "p" };
  assert.deepEqual(Object.keys(childEnv(env)).sort(), ["AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "HOME", "NPM_TOKEN", "PATH", "SSH_AUTH_SOCK"]);
  assert.deepEqual(Object.keys(childEnv(env, true)).sort(), ["HOME", "PATH", "SSH_AUTH_SOCK"]);
  process.env.OPENAI_API_KEY = "sk-should-not-leak"; process.env.MY_BUILD_FLAG = "yes";
  const out = await runShell('echo "[$OPENAI_API_KEY] [$MY_BUILD_FLAG]"', tmpdir(), 5000); assert.match(out, /\[\] \[yes\]/);
});
