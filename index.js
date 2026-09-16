"use strict";

import { Game } from "./core/Game.js";
import { Client } from "./runtime/Client.js";
import { GuideController } from "./ui/controllers/GuideController.js";
import { HomeController } from "./ui/controllers/HomeController.js";
import { RoomController } from "./ui/controllers/RoomController.js";
import { GameApplicationConfig, startGameApplication } from "./ui/GameApplication.js";

const config = new GameApplicationConfig(Game, Client, HomeController, RoomController, GuideController);

await startGameApplication(config);
