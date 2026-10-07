// Stands in for `claude -p` in tests: reads the prompt on stdin and answers the new message.
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const body = prompt.match(/New message:\n<rech_message[^>]*>\n([\s\S]*?)\n<\/rech_message>/)[1];
  console.log(body.includes("thanks") ? "NO_REPLY" : `GPU check passed for: ${body}`);
});
