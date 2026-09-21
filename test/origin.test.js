import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalOrigin } from "../src/domain.js";

test("адрес отдельной сборки приводится к постоянному", () => {
  assert.equal(
    canonicalOrigin("https://812a5350-aqillych.llenyaned.workers.dev"),
    "https://aqillych.llenyaned.workers.dev",
  );
});

test("постоянный адрес не трогаем", () => {
  const url = "https://aqillych.llenyaned.workers.dev";
  assert.equal(canonicalOrigin(url), url);
});

test("дефис в имени воркера — не признак сборки", () => {
  const url = "https://my-crm.acme.workers.dev";
  assert.equal(canonicalOrigin(url), url);
});

test("чужие домены остаются как есть", () => {
  assert.equal(canonicalOrigin("https://crm.example.com"), "https://crm.example.com");
  assert.equal(canonicalOrigin("https://deadbeef-crm.example.com"), "https://deadbeef-crm.example.com");
  assert.equal(canonicalOrigin("http://localhost:8787"), "http://localhost:8787");
});

test("префикс должен быть ровно восемью шестнадцатеричными символами", () => {
  // Короче или длиннее — это часть имени, а не версия.
  assert.equal(canonicalOrigin("https://812a53-crm.acme.workers.dev"), "https://812a53-crm.acme.workers.dev");
  assert.equal(canonicalOrigin("https://812a5350a-crm.acme.workers.dev"), "https://812a5350a-crm.acme.workers.dev");
  assert.equal(canonicalOrigin("https://zzzzzzzz-crm.acme.workers.dev"), "https://zzzzzzzz-crm.acme.workers.dev");
});

test("пустое значение не ломает вызов", () => {
  assert.equal(canonicalOrigin(""), "");
  assert.equal(canonicalOrigin(undefined), "");
});
