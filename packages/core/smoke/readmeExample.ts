import { platformEnvSchema } from "@openlup/core/platform-runtime";

const env = platformEnvSchema.parse({ APP_BASE_URL: "https://shop.example" });
