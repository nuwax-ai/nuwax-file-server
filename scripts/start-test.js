#!/usr/bin/env node
process.env.NODE_ENV = "test";
await import("../src/server.js");
