import { describe, expect, it } from "vitest";
import { parseProvidersSchema, unknownArgsForResource } from "#app/mcp/providerSchema";

const SCHEMA = JSON.stringify({
  format_version: "1.0",
  provider_schemas: {
    "registry.terraform.io/hashicorp/aws": {
      resource_schemas: {
        aws_s3_bucket: {
          block: {
            attributes: { bucket: {}, acl: {}, tags: {} },
            block_types: { versioning: {}, logging: {} },
          },
        },
        aws_instance: {
          block: {
            attributes: { ami: {}, instance_type: {} },
            block_types: { metadata_options: {} },
          },
        },
      },
    },
  },
});

describe("parseProvidersSchema", () => {
  it("maps each resource type to its attributes and nested blocks", () => {
    const schema = parseProvidersSchema(SCHEMA);
    const bucket = schema.get("aws_s3_bucket")!;
    expect([...bucket.attributes].sort()).toEqual(["acl", "bucket", "tags"]);
    expect([...bucket.blocks].sort()).toEqual(["logging", "versioning"]);
    expect(schema.get("aws_instance")!.blocks.has("metadata_options")).toBe(true);
  });

  it("tolerates empty / malformed input", () => {
    expect(parseProvidersSchema("").size).toBe(0);
    expect(parseProvidersSchema("not json").size).toBe(0);
    expect(parseProvidersSchema(JSON.stringify({})).size).toBe(0);
  });

  it("merges resource schemas across multiple providers", () => {
    const merged = JSON.stringify({
      provider_schemas: {
        "registry.terraform.io/hashicorp/aws": {
          resource_schemas: { aws_s3_bucket: { block: { attributes: { bucket: {} } } } },
        },
        "registry.terraform.io/hashicorp/random": {
          resource_schemas: { random_id: { block: { attributes: { byte_length: {} } } } },
        },
      },
    });
    const schema = parseProvidersSchema(merged);
    expect(schema.has("aws_s3_bucket")).toBe(true);
    expect(schema.has("random_id")).toBe(true);
  });
});

describe("unknownArgsForResource", () => {
  const schema = parseProvidersSchema(SCHEMA);

  it("accepts valid attributes and nested blocks", () => {
    expect(
      unknownArgsForResource(schema, "aws_s3_bucket", ["bucket", "acl", "versioning"]),
    ).toEqual({
      unknownResourceType: false,
      unknown: [],
    });
  });

  it("flags an argument that does not exist for the resource (would break plan)", () => {
    // `server_side_encryption_configuration` is inline-deprecated on aws v5 → not in schema.
    expect(
      unknownArgsForResource(schema, "aws_s3_bucket", [
        "bucket",
        "server_side_encryption_configuration",
      ]),
    ).toEqual({ unknownResourceType: false, unknown: ["server_side_encryption_configuration"] });
  });

  it("reports an unknown resource type rather than guessing", () => {
    expect(unknownArgsForResource(schema, "aws_not_a_real_type", ["x"]).unknownResourceType).toBe(
      true,
    );
  });
});
