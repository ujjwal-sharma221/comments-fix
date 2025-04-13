export interface PageCursor {
  lastParentId: string | null;
  lastParentCreatedAt: string | null;

  currentParentId: string | null;
  lastReplyId: string | null;
  lastReplyCreatedAt: string | null;
}

export function encodeCursor(cursor: PageCursor | null): string | null {
  if (!cursor) {
    return null;
  }
  const relevantData = Object.entries(cursor).reduce((acc, [key, value]) => {
    if (value !== null) {
      acc[key as keyof PageCursor] = value;
    }
    return acc;
  }, {} as Partial<PageCursor>);

  if (Object.keys(relevantData).length === 0) {
    return null;
  }

  try {
    const jsonString = JSON.stringify(relevantData);
    return Buffer.from(jsonString).toString("base64");
  } catch (error) {
    console.error("Failed to encode cursor:", error);
    return null;
  }
}

export function decodeCursor(
  cursorString: string | null | undefined
): PageCursor {
  const defaultCursor: PageCursor = {
    lastParentId: null,
    lastParentCreatedAt: null,
    currentParentId: null,
    lastReplyId: null,
    lastReplyCreatedAt: null,
  };

  if (!cursorString) {
    return defaultCursor;
  }

  try {
    const jsonString = Buffer.from(cursorString, "base64").toString("utf-8");
    const decoded = JSON.parse(jsonString);
    // Merge decoded properties into the default structure
    return { ...defaultCursor, ...decoded };
  } catch (error) {
    console.error("Failed to decode cursor string:", cursorString, error);
    // Return default state if decoding fails (e.g., invalid string)
    return defaultCursor;
  }
}

export interface HierarchicalPageCursor {
  lastParentId: string | null;
  lastParentCreatedAt: string | null; // ISO String date
}

export function encodeHierarchicalCursor(
  cursor: HierarchicalPageCursor | null
): string | null {
  if (!cursor || !cursor.lastParentId || !cursor.lastParentCreatedAt) {
    return null; // Only encode if we have valid data
  }
  // Only include non-null values
  const relevantData: Partial<HierarchicalPageCursor> = {};
  if (cursor.lastParentId) relevantData.lastParentId = cursor.lastParentId;
  if (cursor.lastParentCreatedAt)
    relevantData.lastParentCreatedAt = cursor.lastParentCreatedAt;

  if (Object.keys(relevantData).length === 0) {
    return null;
  }
  try {
    const jsonString = JSON.stringify(relevantData);
    return Buffer.from(jsonString).toString("base64");
  } catch (error) {
    console.error("Failed to encode hierarchical cursor:", error);
    return null;
  }
}

// Helper to decode Base64 string back into cursor state
export function decodeHierarchicalCursor(
  cursorString: string | null | undefined
): HierarchicalPageCursor {
  const defaultCursor: HierarchicalPageCursor = {
    lastParentId: null,
    lastParentCreatedAt: null,
  };
  if (!cursorString) {
    return defaultCursor;
  }
  try {
    const jsonString = Buffer.from(cursorString, "base64").toString("utf-8");
    const decoded = JSON.parse(jsonString);
    return { ...defaultCursor, ...decoded };
  } catch (error) {
    console.error(
      "Failed to decode hierarchical cursor string:",
      cursorString,
      error
    );
    return defaultCursor; // Return default on error
  }
}

export interface DFSCursor {
  lastId: string | null;
  lastCreatedAt: string | null; // ISO String date
  // We might need parentId to efficiently find siblings when resuming
  lastParentId: string | null;
}

// Adjust encode/decode functions for this structure
export function encodeDFSCursor(cursor: DFSCursor | null): string | null {
  // Keep null check simple
  if (!cursor || !cursor.lastId || !cursor.lastCreatedAt) {
    return null;
  }
  // No need for partial object, just stringify what we have
  // lastParentId being null is valid and should be included
  try {
    const jsonString = JSON.stringify(cursor);
    return Buffer.from(jsonString).toString("base64");
  } catch (error) {
    console.error("Failed to encode DFS cursor:", error);
    return null;
  }
}

export function decodeDFSCursor(
  cursorString: string | null | undefined
): DFSCursor {
  // Default state matches the interface
  const defaultCursor: DFSCursor = {
    lastId: null,
    lastCreatedAt: null,
    lastParentId: null, // Default parentId is null
  };
  if (!cursorString) {
    return defaultCursor;
  }
  try {
    const jsonString = Buffer.from(cursorString, "base64").toString("utf-8");
    // Merge decoded properties, letting JSON handle nulls correctly
    const decoded = JSON.parse(jsonString);
    return { ...defaultCursor, ...decoded };
  } catch (error) {
    console.error("Failed to decode DFS cursor string:", cursorString, error);
    return defaultCursor; // Return default on error
  }
}
