const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let initialized = false;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    setTimeout(
      () => send({ id: m.id, result: { userAgent: "test" } }),
      Number(process.env.INIT_DELAY || 0),
    );
    return;
  }
  if (m.method === "initialized") {
    initialized = true;
    return;
  }
  if (m.id === 900) {
    send({ method: "answer", params: { result: m.result } });
    return;
  }
  if (!initialized) {
    send({ id: m.id, error: { code: -1, message: "Not initialized" } });
    return;
  }
  switch (m.method) {
    case "echo":
      setTimeout(
        () => send({ id: m.id, result: m.params }),
        m.params.delay || 0,
      );
      break;
    case "error":
      send({
        id: m.id,
        error: { code: 123, message: "Rejected", data: { hint: "fix" } },
      });
      break;
    case "stream":
      process.stdout.write('not json\nnull\n[]\n42\n{"method":42}\n');
      const data =
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { delta: "안녕" },
        }) + "\n";
      process.stdout.write(data.slice(0, 14));
      setTimeout(() => {
        process.stdout.write(data.slice(14));
        send({ id: m.id, result: { ok: true } });
      }, 5);
      break;
    case "ask":
      send({
        id: 900,
        method: "item/commandExecution/requestApproval",
        params: { command: "echo safe" },
      });
      send({ id: m.id, result: { ok: true } });
      break;
    case "crash":
      process.exit(7);
      break;
    case "hang":
      break;
    default:
      send({ id: m.id, result: {} });
  }
});
