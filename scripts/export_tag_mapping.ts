// Prints server/tagio/mapping.ts as JSON so the Python fixture writer and raw
// inspector use the same table as the implementation.
import { FIELD_MAPPINGS } from "../server/tagio/mapping.ts";
console.log(JSON.stringify(FIELD_MAPPINGS, null, 2));
