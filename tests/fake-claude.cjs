const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    if (m.request.subtype === "initialize")
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: m.request_id,
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: ["default"],
            models: [{ value: "fixture", displayName: "Fixture model" }],
            account: { apiProvider: "firstParty" },
          },
        },
      });
    else
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: m.request_id,
          response: {},
        },
      });
  } else if (m.type === "user") {
    send({
      type: "control_request",
      request_id: "tool-permission",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        tool_use_id: "write-fixture",
        input: { file_path: "/fixture/A.md", content: "never written" },
      },
    });
  } else if (
    m.type === "control_response" &&
    m.response.request_id === "tool-permission"
  ) {
    send({
      type: "assistant",
      uuid: "assistant-fixture",
      session_id: "fixture-session",
      parent_tool_use_id: null,
      message: {
        id: "fixture-message",
        role: "assistant",
        content: [
          { type: "text", text: "Decision " + m.response.response.behavior },
        ],
      },
    });
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "fixture-session",
      uuid: "result-fixture",
      result: "Done",
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      permission_denials: [],
    });
  }
});
rl.on("close", () => process.exit(0));
