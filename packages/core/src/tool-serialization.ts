import { SerializationError } from "./errors.js";
import { assertJsonSerializable } from "./session-store.js";

export interface ToolValueSerializer {
  serialize(value: unknown): unknown;
  deserialize(value: unknown): unknown;
}

export interface ToolSerialization {
  args?: ToolValueSerializer;
  result?: ToolValueSerializer;
  streamChunk?: ToolValueSerializer;
}

export type ToolSerializers = Record<string, ToolSerialization>;

export function serializeToolValue(
  serializers: ToolSerializers | undefined,
  toolName: string,
  slot: keyof ToolSerialization,
  value: unknown,
  label: string
): unknown {
  const serializer = serializers?.[toolName]?.[slot];
  const serialized = serializer ? serializer.serialize(value) : value;
  try {
    assertJsonSerializable(serialized, label);
  } catch (error) {
    if (serializer && error instanceof SerializationError) {
      throw new SerializationError("Tool serializer returned a non-JSON-serializable value", {
        label,
        cause: error.data
      });
    }
    throw error;
  }
  return serialized;
}

export function deserializeToolValue(
  serializers: ToolSerializers | undefined,
  toolName: string,
  slot: keyof ToolSerialization,
  value: unknown
): unknown {
  const serializer = serializers?.[toolName]?.[slot];
  return serializer ? serializer.deserialize(value) : value;
}
