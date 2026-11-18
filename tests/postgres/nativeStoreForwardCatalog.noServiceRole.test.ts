import { describe } from "vitest";
import { registerNativeStoreForwardCatalog } from "./nativeStoreForwardCatalog.shared.js";

describe.each([{ serviceRole: false }])("native store forward catalog, service_role present: $serviceRole", registerNativeStoreForwardCatalog);
