import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLine, parseList, contactKey, contactUrl, looksLikeContact } from "../src/parse.js";

test("разбирает строку «имя — контакт — ниша»", () => {
  assert.deepEqual(parseLine("Ахмад — @ahmad_arabic — преподаёт арабский"), {
    name: "Ахмад",
    contact: "@ahmad_arabic",
    niche: "преподаёт арабский",
  });
});

test("принимает | и ; как разделители", () => {
  assert.deepEqual(parseLine("Иса | t.me/isa_coach | тренер по борьбе"), {
    name: "Иса",
    contact: "t.me/isa_coach",
    niche: "тренер по борьбе",
  });
  assert.equal(parseLine("Юсуф; @yusuf_finance; финансы").niche, "финансы");
});

test("контакт узнаётся в любом месте строки", () => {
  assert.deepEqual(parseLine("@yusuf_finance — Юсуф — финансы"), {
    name: "Юсуф",
    contact: "@yusuf_finance",
    niche: "финансы",
  });
});

test("из одного ника делает и имя, и контакт", () => {
  assert.deepEqual(parseLine("@yusuf_finance"), {
    name: "@yusuf_finance",
    contact: "@yusuf_finance",
    niche: "",
  });
});

test("из голой ссылки тоже получается карточка", () => {
  assert.deepEqual(parseLine("https://t.me/isa_coach"), {
    name: "@isa_coach",
    contact: "https://t.me/isa_coach",
    niche: "",
  });
});

test("имя с дефисом не разрезается: дефис-разделитель только в пробелах", () => {
  assert.equal(parseLine("Абдул-Азиз — @abdulaziz").name, "Абдул-Азиз");
});

test("человек без контакта всё равно заводится", () => {
  assert.deepEqual(parseLine("Марьям — нутрициолог"), {
    name: "Марьям",
    contact: "",
    niche: "нутрициолог",
  });
});

test("лишние части уходят в нишу", () => {
  assert.equal(parseLine("Иса | @isa | борьба | Ташкент").niche, "борьба, Ташкент");
});

test("пустые строки пропускаются", () => {
  const rows = parseList("Ахмад — @a1\n\n   \nИса — @a2\n");
  assert.equal(rows.length, 2);
});

test("дубли внутри одной пачки схлопываются", () => {
  const rows = parseList("Ахмад — @ahmad\nАхмад ещё раз — https://t.me/AHMAD/\nИса — @isa");
  assert.deepEqual(rows.map((r) => r.name), ["Ахмад", "Иса"]);
});

test("люди без контакта не считаются дублями друг друга", () => {
  const rows = parseList("Марьям — нутрициолог\nФотима — таргет");
  assert.equal(rows.length, 2);
});

test("один и тот же телеграм в разных видах даёт один ключ", () => {
  const same = ["@ivan", "t.me/ivan", "https://t.me/ivan", "https://t.me/ivan/", "T.ME/IVAN", "telegram.me/ivan"];
  for (const s of same) assert.equal(contactKey(s), "tg:ivan", s);
});

test("инстаграм и телеграм с одним ником — разные люди", () => {
  assert.equal(contactKey("instagram.com/ivan"), "ig:ivan");
  assert.notEqual(contactKey("instagram.com/ivan"), contactKey("@ivan"));
});

test("телефон нормализуется до цифр", () => {
  assert.equal(contactKey("+998 90 123-45-67"), "tel:998901234567");
  assert.equal(contactKey("998901234567"), "tel:998901234567");
});

test("query и хвостовой слэш не плодят дубли", () => {
  assert.equal(contactKey("example.com/ivan/?utm=1"), "example.com/ivan");
});

test("пустой контакт даёт пустой ключ — в уникальный индекс не попадёт", () => {
  assert.equal(contactKey(""), "");
  assert.equal(contactKey("   "), "");
});

test("ссылка для нажатия строится только когда есть куда вести", () => {
  assert.equal(contactUrl("@ivan"), "https://t.me/ivan");
  assert.equal(contactUrl("t.me/ivan"), "https://t.me/ivan");
  assert.equal(contactUrl("https://example.com/ivan"), "https://example.com/ivan");
  assert.equal(contactUrl("Иван из зала"), "");
  assert.equal(contactUrl("+998901234567"), "");
});

test("имя и ниша за контакт не принимаются", () => {
  assert.equal(looksLikeContact("Ахмад"), false);
  assert.equal(looksLikeContact("преподаёт арабский"), false);
  assert.equal(looksLikeContact("@ahmad_arabic"), true);
});
