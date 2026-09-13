import test from "node:test";
import assert from "node:assert/strict";
import { assertPrivateTelegramChat } from "../src/telegram.js";

test("acepta una conversación privada cuyo chat coincide con el usuario", () => {
  assert.doesNotThrow(() => assertPrivateTelegramChat({
    message: { chat: { id: 987654321, type: "private" } },
    from: { id: 987654321 },
    chatId: 987654321,
  }));
});

test("rechaza grupos y supergrupos antes de consultar la identidad", () => {
  for (const type of ["group", "supergroup", "channel"]) {
    assert.throws(
      () => assertPrivateTelegramChat({
        message: { chat: { id: -1001234567890, type } },
        from: { id: 987654321 },
        chatId: -1001234567890,
      }),
      (error) => error.code === "private_chat_required" && error.status === 403,
    );
  }
});
