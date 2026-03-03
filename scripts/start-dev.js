#!/usr/bin/env node
process.env.NODE_ENV = "development";
await import("../src/server.js");
