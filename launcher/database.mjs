
import { databaseConfig, readConfig } from "./serve.mjs";

const root = process.argv[2] ?? process.cwd();

try {
  const { adapter, database } = databaseConfig(root, readConfig(root), process.env);

  console.log(adapter);
  console.log(database);
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
