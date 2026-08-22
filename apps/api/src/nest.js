import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { requestHandler } from "./index.js";
import { loadConfig } from "@myknow/config";

class AppModule {}
Module({})(AppModule);
const config = loadConfig();
const app = await NestFactory.create(AppModule);
app.getHttpAdapter().getInstance().use(requestHandler);
await app.listen(config.apiPort);
console.log(`NestJS API listening on http://localhost:${config.apiPort}`);
