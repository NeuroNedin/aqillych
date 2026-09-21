#!/usr/bin/env node
// Печатает структуру базы как SQL — нужно локальным проверкам,
// которые поднимают базу заранее.
import { SCHEMA } from "../src/schema.js";
console.log(SCHEMA.map((s) => `${s};`).join("\n\n"));
