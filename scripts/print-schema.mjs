#!/usr/bin/env node
// Печатает структуру базы как SQL — нужно локальным проверкам,
// которые поднимают базу заранее.
import { TABLES, INDEXES, UNIQUE_CONTACT_INDEX } from "../src/schema.js";
console.log([...TABLES, ...INDEXES, UNIQUE_CONTACT_INDEX].map((s) => `${s};`).join("\n\n"));
