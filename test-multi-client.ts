import WebSocket from "ws";

async function run() {
  const client1 = "client_test_a_" + Math.random().toString(36).substring(2, 7);
  const client2 = "client_test_b_" + Math.random().toString(36).substring(2, 7);

  console.log("Connecting client 1:", client1);
  const ws1 = new WebSocket(`wss://la-sala.luisgerardope384.workers.dev/api/sala/ws?clientId=${client1}`);
  
  ws1.on("open", () => console.log("Client 1 OPEN"));
  ws1.on("message", (msg) => console.log("Client 1 RECV:", msg.toString()));
  ws1.on("close", (code, reason) => console.log("Client 1 CLOSE:", code, reason.toString()));

  await new Promise(r => setTimeout(r, 2000));

  console.log("Connecting client 2:", client2);
  const ws2 = new WebSocket(`wss://la-sala.luisgerardope384.workers.dev/api/sala/ws?clientId=${client2}`);
  
  ws2.on("open", () => console.log("Client 2 OPEN"));
  ws2.on("message", (msg) => console.log("Client 2 RECV:", msg.toString()));
  ws2.on("close", (code, reason) => console.log("Client 2 CLOSE:", code, reason.toString()));

  await new Promise(r => setTimeout(r, 2000));

  console.log("Client 1 sends message: 'hola desde 1'");
  ws1.send(JSON.stringify({ type: "send_message", text: "hola desde 1" }));

  await new Promise(r => setTimeout(r, 3000));

  ws1.close();
  ws2.close();
}

run().catch(console.error);
