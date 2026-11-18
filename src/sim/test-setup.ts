import { freezeHeld } from "./parse-cache.js";

// Every test runs with held state frozen, so content that changes it in place fails there (#470).
freezeHeld(true);
