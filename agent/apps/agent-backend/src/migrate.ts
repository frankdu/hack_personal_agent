import { Store } from "./store.js";
import { readConfig } from "./config.js";
const store = new Store(readConfig());
try {
  await store.migrate();
  console.log("Backend migrations applied.");
} finally {
  await store.pool.end();
}
