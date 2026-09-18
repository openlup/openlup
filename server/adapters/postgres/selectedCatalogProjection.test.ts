import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "./selectedCatalogProjection.js";

// `assertObjectInventory` refuses a boot whose live projection serializes differently.
// A move that reorders a key, drops a field, or reshapes an identity would therefore
// brick every existing deployment on its next start - and would do it silently here,
// because every other test in this file stubs the projector out. The literals below are
// the only place the format itself is written down.
const CATALOG_QUERY_NAME = "oss-phase2-selected-catalog-v2";
const CATALOG_SQL_SHA256 = "8c9494f87d3147ec25bf0d6461ed214061e410b2594186cb4b90baea60dca54c";
const PROJECTION_DIGEST = "68ab4e7bbd4f659b4fbf28c8a861b99b83870d86f24821a107a150a4d964ab29";
// Single-line on purpose: this is a byte pin, and a reflowed literal is a different pin.
const PROJECTION_PAYLOAD = `{"aclGrants":[{"aclOrigin":"built-in-default","grantee":"PUBLIC","grantor":"app_owner","identity":{"arguments":["schema","app_owner","PUBLIC","usage","false","built-in-default"],"kind":"acl-grant","name":"platform","schema":null},"isGrantable":false,"privilege":"usage","targetClass":"schema","targetIdentity":{"arguments":[],"kind":"schema","name":"platform","schema":null}},{"aclOrigin":"stored","grantee":"app_reader","grantor":"app_owner","identity":{"arguments":["relation","app_owner","app_reader","select","false","stored"],"kind":"acl-grant","name":"widgets","schema":"platform"},"isGrantable":false,"privilege":"select","targetClass":"relation","targetIdentity":{"arguments":[],"kind":"relation","name":"widgets","schema":"platform"}}],"defaultPrivileges":[{"grantee":"app_reader","grantor":"app_owner","identity":{"arguments":["relation","app_owner","app_reader","select","false"],"kind":"default-privilege","name":"app_owner","schema":"platform"},"isGrantable":false,"objectClass":"relation","ownerRole":"app_owner","privilege":"select","schema":"platform"}],"objects":[{"attributesDigest":"6e0344ede8aa1ab7ce723cc708b4e02dfaf9c1fac3575232217d8be773caa03f","definitionDigest":null,"identity":{"arguments":["relation","app_owner","app_reader","select","false","stored"],"kind":"acl-grant","name":"widgets","schema":"platform"}},{"attributesDigest":"194814200cd7e0584dcfc87194f0c33ef9b18990925b472542b6e5ff431350cf","definitionDigest":null,"identity":{"arguments":["schema","app_owner","PUBLIC","usage","false","built-in-default"],"kind":"acl-grant","name":"platform","schema":null}},{"attributesDigest":"9fad2cfca1674d0c68bf7bdeedb0f5d7375f80acdbc4d09de0e247804718168d","definitionDigest":"1232c809eccd49fafcacf7aeef10c294d6b04a14c1db12ddcc90c12009dcf31f","identity":{"arguments":["widgets"],"kind":"column","name":"id","schema":"platform"}},{"attributesDigest":"47f492d02298bd6b95ed3400c1fe00b89ac8ff7592e208cec8f8c2ebce85de3a","definitionDigest":null,"identity":{"arguments":["relation","app_owner","app_reader","select","false"],"kind":"default-privilege","name":"app_owner","schema":"platform"}},{"attributesDigest":"afa0dbcf2a1dc0b23b0014f55a7538858c8240e660653f7cba4106bab5642f67","definitionDigest":null,"identity":{"arguments":[],"kind":"extension","name":"pgcrypto","schema":null}},{"attributesDigest":"b1aaf0c364cdff500324618d48e75269168dbb9fe57828021a669726170e1e41","definitionDigest":"8018bde3922b74da2fb27f36db03a97681f3684f7a596b370c56926d8c49e3a9","identity":{"arguments":["integer","text"],"kind":"function","name":"touch","schema":"platform"}},{"attributesDigest":"adfb7af9fceb747947049ce5e3067bf6ab3a8ea4828eec7a51fe60f1a614f12d","definitionDigest":"439a40534dd5df2b20be519adefaa8ae371b26599eb5d2d82150d84afd3e7339","identity":{"arguments":["widgets"],"kind":"index","name":"widgets_pkey","schema":"platform"}},{"attributesDigest":"21a3ad56475e4c39cb345f90d40f787e6b39b716b9c030c7ace240211cdd13bc","definitionDigest":"0c5ccf9c07624ad873c41fb1beb21a23bee2f8326e0f802950aa8b9594113cce","identity":{"arguments":["widgets"],"kind":"policy","name":"widgets_read","schema":"platform"}},{"attributesDigest":"f51430993f9b7097176a67815276f64abc4fad504ac026ec6a61fee8ac976bba","definitionDigest":null,"identity":{"arguments":[],"kind":"relation","name":"widgets","schema":"platform"}},{"attributesDigest":"793215446f4b7e7e77162cd9bd8c714c8bc8a08180d3c4efcb875a816b5bb1ee","definitionDigest":null,"identity":{"arguments":[],"kind":"role","name":"app_owner","schema":null}},{"attributesDigest":"a3e729dc5083715d7a413d27f59126ca92b0a28a6601253904a78e39ab9e63fc","definitionDigest":null,"identity":{"arguments":[],"kind":"role","name":"app_reader","schema":null}},{"attributesDigest":"147d1930c01f18304d9f2bdf4ec7888a4740551ec01b0955ac2c292f56fb2f58","definitionDigest":null,"identity":{"arguments":["app_reader","app_owner","false","true","true"],"kind":"role-membership","name":"app_owner","schema":null}},{"attributesDigest":"8913a924be4f00d998fb1e3bafb79bdaee346f2e8e18ca8b357a0526ebafe4f0","definitionDigest":null,"identity":{"arguments":[],"kind":"schema","name":"platform","schema":null}},{"attributesDigest":"07f7b6b67ecece1e368920b93c776d56f0ebd2132c42999c3ad9950fce588181","definitionDigest":null,"identity":{"arguments":[],"kind":"type","name":"state","schema":"platform"}}],"ownerships":[{"object":{"arguments":["integer","text"],"kind":"function","name":"touch","schema":"platform"},"ownerRole":"app_owner"},{"object":{"arguments":[],"kind":"extension","name":"pgcrypto","schema":null},"ownerRole":"app_owner"},{"object":{"arguments":[],"kind":"relation","name":"widgets","schema":"platform"},"ownerRole":"app_owner"},{"object":{"arguments":[],"kind":"schema","name":"platform","schema":null},"ownerRole":"app_owner"},{"object":{"arguments":[],"kind":"type","name":"state","schema":"platform"},"ownerRole":"app_owner"}],"roleMemberships":[{"adminOption":false,"grantedRole":"app_owner","grantorRole":"app_owner","identity":{"arguments":["app_reader","app_owner","false","true","true"],"kind":"role-membership","name":"app_owner","schema":null},"inheritOption":true,"memberRole":"app_reader","setOption":true}],"roles":[{"bypassRls":false,"canLogin":false,"connectionLimit":-1,"createDb":false,"createRole":false,"identity":{"arguments":[],"kind":"role","name":"app_owner","schema":null},"inherits":true,"replication":false,"superuser":false,"validUntil":null},{"bypassRls":false,"canLogin":true,"connectionLimit":5,"createDb":false,"createRole":false,"identity":{"arguments":[],"kind":"role","name":"app_reader","schema":null},"inherits":true,"replication":false,"superuser":false,"validUntil":"2030-01-01T00:00:00.000000Z"}]}`;

const attributes = (value: Record<string, unknown>): string => JSON.stringify(value);

/**
 * One row per branch of the projector: both ACL origins, both nullable schemas, a routine
 * identity with argument types, a definition-bearing row and a definition-free row, plus
 * the default-privilege, role-membership, role and ownership records that only exist in
 * the payload's five non-object sections.
 */
const CATALOG_FIXTURE_ROWS = [
  {
    kind: "role", schema: null, name: "app_owner", arguments: [], definition: null,
    attributes: attributes({
      login: false, inherit: true, superuser: false, createRole: false, createDb: false,
      replication: false, bypassRls: false, connectionLimit: -1, validUntil: null, description: null,
    }),
  },
  {
    kind: "role", schema: null, name: "app_reader", arguments: [], definition: null,
    attributes: attributes({
      login: true, inherit: true, superuser: false, createRole: false, createDb: false,
      replication: false, bypassRls: false, connectionLimit: 5,
      validUntil: "2030-01-01T00:00:00.000000Z", description: "read-only principal",
    }),
  },
  {
    kind: "schema", schema: null, name: "platform", arguments: [], definition: null,
    attributes: attributes({ owner: "app_owner", aclStored: true, description: "platform schema" }),
  },
  {
    kind: "relation", schema: "platform", name: "widgets", arguments: [], definition: null,
    attributes: attributes({
      kind: "r", owner: "app_owner", rls: true, forceRls: false, aclStored: true, description: null,
    }),
  },
  {
    kind: "column", schema: "platform", name: "id", arguments: ["widgets"],
    definition: "nextval('platform.widgets_id_seq'::regclass)",
    attributes: attributes({
      ordinal: 1, type: "integer", notNull: true, identity: "", generated: "",
      aclStored: false, description: null,
    }),
  },
  {
    kind: "function", schema: "platform", name: "touch", arguments: ["integer", "text"],
    definition: "CREATE OR REPLACE FUNCTION platform.touch(integer, text)\n RETURNS void\n LANGUAGE sql\nAS $function$ SELECT 1 $function$\n",
    attributes: attributes({
      kind: "f", owner: "app_owner", securityDefiner: true, volatility: "v",
      aclStored: false, description: null,
    }),
  },
  {
    kind: "index", schema: "platform", name: "widgets_pkey", arguments: ["widgets"],
    definition: "CREATE UNIQUE INDEX widgets_pkey ON platform.widgets USING btree (id)",
    attributes: attributes({ valid: true, unique: true, primary: true, description: null }),
  },
  {
    kind: "policy", schema: "platform", name: "widgets_read", arguments: ["widgets"],
    definition: "r|(true)|",
    attributes: attributes({ permissive: true, roles: ["app_reader"], description: null }),
  },
  {
    kind: "type", schema: "platform", name: "state", arguments: [], definition: null,
    attributes: attributes({
      kind: "e", category: "E", notNull: false, base: "-", owner: "app_owner",
      aclStored: false, description: null,
    }),
  },
  {
    kind: "extension", schema: null, name: "pgcrypto", arguments: [], definition: null,
    attributes: attributes({
      version: "1.3", schema: "platform", owner: "app_owner", description: null,
    }),
  },
  {
    kind: "acl-grant", schema: "platform", name: "widgets",
    arguments: ["relation", "app_owner", "app_reader", "select", "false", "stored"], definition: null,
    attributes: attributes({
      targetClass: "relation",
      targetIdentity: { kind: "relation", schema: "platform", name: "widgets", arguments: [] },
      grantor: "app_owner", grantee: "app_reader", privilege: "select",
      isGrantable: false, aclOrigin: "stored",
    }),
  },
  {
    kind: "acl-grant", schema: null, name: "platform",
    arguments: ["schema", "app_owner", "PUBLIC", "usage", "false", "built-in-default"], definition: null,
    attributes: attributes({
      targetClass: "schema",
      targetIdentity: { kind: "schema", schema: null, name: "platform", arguments: [] },
      grantor: "app_owner", grantee: "PUBLIC", privilege: "usage",
      isGrantable: false, aclOrigin: "built-in-default",
    }),
  },
  {
    kind: "default-privilege", schema: "platform", name: "app_owner",
    arguments: ["relation", "app_owner", "app_reader", "select", "false"], definition: null,
    attributes: attributes({
      objectClass: "relation", schema: "platform", ownerRole: "app_owner", grantor: "app_owner",
      grantee: "app_reader", privilege: "select", isGrantable: false,
    }),
  },
  {
    kind: "role-membership", schema: null, name: "app_owner",
    arguments: ["app_reader", "app_owner", "false", "true", "true"], definition: null,
    attributes: attributes({
      grantedRole: "app_owner", memberRole: "app_reader", grantorRole: "app_owner",
      adminOption: false, inheritOption: true, setOption: true,
    }),
  },
] as const;

function catalogStub() {
  const asked: { name: string; text: string }[] = [];
  const client = {
    async query(config: { name: string; text: string }) {
      asked.push(config);
      return { rows: CATALOG_FIXTURE_ROWS.map((row) => ({ ...row, arguments: [...row.arguments] })) };
    },
  };
  return { client: client as never, asked };
}

describe("selected-catalog-v2 projection format", () => {
  it("serializes a fixed catalog to exactly the pinned inventory bytes", async () => {
    const stub = catalogStub();
    const projection = await readSelectedCatalogProjection(stub.client);
    expect(selectedCatalogProjectionPayload(projection)).toBe(PROJECTION_PAYLOAD);
    expect(createHash("sha256").update(PROJECTION_PAYLOAD).digest("hex")).toBe(PROJECTION_DIGEST);
    expect(projection.digest).toBe(PROJECTION_DIGEST);
  });

  it("asks the database for the pinned prepared statement and SQL bytes", async () => {
    const stub = catalogStub();
    await readSelectedCatalogProjection(stub.client);
    expect(stub.asked).toHaveLength(1);
    expect(stub.asked[0]!.name).toBe(CATALOG_QUERY_NAME);
    expect(createHash("sha256").update(stub.asked[0]!.text).digest("hex")).toBe(CATALOG_SQL_SHA256);
  });

  it("refuses to serialize a projection it did not validate", () => {
    // The dynamic PROJECTOR_MODULE import used to be the only thing asserting that both
    // exports exist and are callable; a static import proves that at compile time, and
    // this keeps the runtime half - a hand-built look-alike is still rejected.
    expect(typeof readSelectedCatalogProjection).toBe("function");
    expect(typeof selectedCatalogProjectionPayload).toBe("function");
    expect(() => selectedCatalogProjectionPayload({
      objects: [], aclGrants: [], defaultPrivileges: [], roleMemberships: [], roles: [], ownerships: [],
      digest: "0".repeat(64),
    } as never)).toThrow("selected catalog projection is not validated");
  });
});
