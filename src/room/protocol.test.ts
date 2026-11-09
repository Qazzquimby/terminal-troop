import { describe, expect, expectTypeOf, test } from "vitest";
import { NetEvent } from "../net/index.js";
import { roomMessages } from "./protocol.js";
import type { Message, MessageInput, RoomMessages } from "./protocol.js";

const messages = roomMessages(3);

describe("the message table", () => {
  test("covers every event", () => {
    expectTypeOf<keyof RoomMessages>().toEqualTypeOf<NetEvent>();
    expect(Object.keys(messages).sort()).toEqual(
      Object.values(NetEvent).sort(),
    );
  });

  test("types each payload by its event", () => {
    expectTypeOf<Message<"bye">>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<Message<"hello">>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<MessageInput<"state">>().toEqualTypeOf<{
      id: string;
      name: string;
      x: number;
      y: number;
      aim: number;
    }>();
    expectTypeOf<Message<"signal">>().toBeUnknown();
  });

  test("a STATE's name is cut to nameMax", () => {
    const parsed = messages.state.safeParse({
      id: "x",
      name: "ABCDE",
      x: 1,
      y: 2,
      aim: 0,
    });
    expect(parsed.data?.name).toBe("ABC");
  });

  test.each([
    [NetEvent.HELLO, { id: "" }],
    [NetEvent.BYE, { id: 7 }],
    [NetEvent.STATE, { id: "x", name: "X", x: Number.NaN, y: 0, aim: 0 }],
    [NetEvent.STATE, { id: "x", name: "X", x: 0, y: 0 }],
  ])("a bad %s payload does not parse", (event, payload) => {
    expect(messages[event].safeParse(payload).success).toBe(false);
  });
});
