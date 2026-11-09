import { expect, test } from "vitest";
import {
  parseRoomCode,
  playerName,
  randomRoomCode,
  roomKey,
} from "./room-code.js";

test("a room code is trimmed and upper-cased", () => {
  expect(parseRoomCode("  abc12 ")).toBe("ABC12");
});

test("a room code is 3 to 8 letters or digits", () => {
  expect(parseRoomCode("AB")).toBeNull();
  expect(parseRoomCode("ABC")).toBe("ABC");
  expect(parseRoomCode("ABCDEFGH")).toBe("ABCDEFGH");
  expect(parseRoomCode("ABCDEFGHI")).toBeNull();
  expect(parseRoomCode("AB-CD")).toBeNull();
  expect(parseRoomCode("")).toBeNull();
});

test("a random room code has one parseable character per byte", () => {
  const code = randomRoomCode(new Uint8Array([0, 9, 10, 35, 36, 255]));
  expect(code).toBe("09AZ03");
  expect(parseRoomCode(code)).toBe(code);
});

test("the room key keeps the plain code for standard and tags other worlds", () => {
  expect(roomKey("ABC", "standard")).toBe("ABC");
  expect(roomKey("ABC", "dev")).toBe("dev:ABC");
});

test("a player name is trimmed and cut, falling back when empty", () => {
  expect(playerName("  Alice  ", 8, "AB12")).toBe("Alice");
  expect(playerName("Bartholomew", 8, "AB12")).toBe("Bartholo");
  expect(playerName("   ", 8, "AB12")).toBe("AB12");
});
