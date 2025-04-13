import { Hono } from "hono";
import { Comments, PrismaClient } from "./generated/prisma";
import {
  decodeCursor,
  decodeDFSCursor,
  decodeHierarchicalCursor,
  DFSCursor,
  encodeCursor,
  encodeDFSCursor,
  encodeHierarchicalCursor,
  HierarchicalPageCursor,
  PageCursor,
} from "./lib/utils";

const app = new Hono();

async function findNextNodeDFS(
  db: PrismaClient,
  previousNode: { id: string; createdAt: Date; parentId: string | null } | null
): Promise<Comments | null> {
  // ... (implementation from previous answer) ...
  if (!previousNode) {
    // If no previous node, find the very first top-level comment
    console.log("[DFS] Finding first root node.");
    return await db.comments.findFirst({
      where: { parentId: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  // 1. Try Descending (Find First Child)
  console.log(`[DFS] Finding first child of ${previousNode.id}`);
  const firstChild = await db.comments.findFirst({
    where: { parentId: previousNode.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (firstChild) {
    console.log(`[DFS] Found child: ${firstChild.id}`);
    return firstChild;
  }

  console.log(
    `[DFS] No child found for ${previousNode.id}. Trying siblings/ancestors.`
  );

  // 2. & 3. Try Ascending to find Next Sibling (of self or ancestor)
  let currentNodeForAscent = previousNode; // Use a different variable name to avoid confusion
  while (true) {
    if (currentNodeForAscent.parentId === null) {
      console.log(
        `[DFS] Reached root (${currentNodeForAscent.id}) while searching for siblings.`
      );
      break;
    }

    console.log(
      `[DFS] Finding next sibling of ${currentNodeForAscent.id} (Parent: ${currentNodeForAscent.parentId})`
    );
    const nextSibling = await db.comments.findFirst({
      where: {
        parentId: currentNodeForAscent.parentId,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      cursor: {
        parentId_createdAt_id: {
          parentId: currentNodeForAscent.parentId,
          createdAt: currentNodeForAscent.createdAt,
          id: currentNodeForAscent.id,
        },
      },
      skip: 1,
    });

    if (nextSibling) {
      console.log(`[DFS] Found next sibling: ${nextSibling.id}`);
      return nextSibling;
    }

    console.log(
      `[DFS] No sibling found for ${currentNodeForAscent.id}. Moving up.`
    );
    const parentNode = await db.comments.findUnique({
      where: { id: currentNodeForAscent.parentId },
    });
    if (!parentNode) {
      console.error(
        `[DFS] Error: Parent node ${currentNodeForAscent.parentId} not found during ascent.`
      );
      return null;
    }
    currentNodeForAscent = parentNode;
  }

  // 4. Try Moving to the Next Root
  console.log(`[DFS] Finding next root after root ${currentNodeForAscent.id}`);
  const nextRoot = await db.comments.findFirst({
    where: { parentId: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    cursor: {
      createdAt_id: {
        createdAt: currentNodeForAscent.createdAt,
        id: currentNodeForAscent.id,
      },
    },
    skip: 1,
  });

  if (nextRoot) {
    console.log(`[DFS] Found next root: ${nextRoot.id}`);
    return nextRoot;
  }

  console.log("[DFS] No next node found anywhere. End of comments.");
  return null;
}

interface CommentWithReplies extends Comments {
  replies?: (CommentWithReplies & { _count?: { replies: number } })[]; // Recursive structure
  _count?: {
    // Optional: Count direct replies
    replies: number;
  };
}

interface HierarchicalPaginatedResponse {
  comments: CommentWithReplies[]; // Array of top-level comments with nested replies
  nextCursor: string | null;
  // totalTopLevelComments: number; // More relevant count for pagination controls
}

interface PaginatedCommentsResponse {
  comments: Comments[];
  nextCursor: string | null;
  totalItemsInPage: number;
}

const db = new PrismaClient();

app.get("/", (c) => c.text("Hello Bun!"));

app.post("/create", async (c) => {
  const body = await c.req.json();

  try {
    const comment = await db.comments.create({
      data: {
        comment: body.comment,
        parentId: body.parentId,
      },
    });
    return c.json({ comment });
  } catch (error) {
    console.log(error);
    return c.json({ error });
  }
});

app.get("/comments", async (c) => {
  const cursor = c.req.query("cursor") ?? "";
  const limit = parseInt(c.req.query("limit") ?? "10");

  const currentCursor = decodeCursor(cursor);
  const result: Comments[] = [];
  let itemsAdded = 0;
  const totalComments = await db.comments.count();

  let nextCursor: PageCursor = { ...currentCursor };

  let hasMore = false;
  while (itemsAdded < limit) {
    if (nextCursor.currentParentId) {
      console.log("Resuming replies from the parent");
      const repliesToFetch = limit - itemsAdded;
      const replyCursor =
        nextCursor.currentParentId && // Need parentId for the key
        nextCursor.lastReplyId &&
        nextCursor.lastReplyCreatedAt
          ? {
              // Use the composite unique constraint name from the schema: parentId_createdAt_id
              parentId_createdAt_id: {
                parentId: nextCursor.currentParentId, // Include parentId here
                createdAt: new Date(nextCursor.lastReplyCreatedAt),
                id: nextCursor.lastReplyId,
              },
            }
          : undefined;

      const replies = await db.comments.findMany({
        where: {
          parentId: nextCursor.currentParentId,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: repliesToFetch + 1,
        cursor: replyCursor,
        skip: replyCursor ? 1 : 0,
      });

      const repliesToAdd = replies.slice(0, repliesToFetch);
      hasMore = replies.length > repliesToFetch;

      if (repliesToAdd.length === 0) {
        console.log(
          `[State 1] No more replies for Parent: ${nextCursor.currentParentId}. Moving to next parent.`
        );
        nextCursor.currentParentId = null;
        nextCursor.lastReplyId = null;
        nextCursor.lastReplyCreatedAt = null;
        continue;
      }

      for (const reply of repliesToAdd) {
        result.push(reply);
        itemsAdded++;
        nextCursor.lastReplyId = reply.id;
        nextCursor.lastReplyCreatedAt = reply.createdAt.toISOString();
        if (itemsAdded === limit) break;
      }
      if (itemsAdded === limit || !hasMore) {
        if (!hasMore) {
          console.log(
            `[State 1] Exhausted replies for Parent: ${nextCursor.currentParentId} within this fetch.`
          );

          nextCursor.currentParentId = null;
          nextCursor.lastReplyId = null;
          nextCursor.lastReplyCreatedAt = null;
        } else {
          console.log(
            `[State 1] Page filled mid-replies for Parent: ${nextCursor.currentParentId}. Next cursor points to Reply: ${nextCursor.lastReplyId}`
          );
        }

        if (itemsAdded === limit) break;
      }
      continue;
    } else {
      console.log(
        `[State 2] Fetching next Parent after Parent: ${nextCursor.lastParentId}`
      );
      const parentCursor =
        nextCursor.lastParentId && nextCursor.lastParentCreatedAt
          ? {
              createdAt_id: {
                createdAt: new Date(nextCursor.lastParentCreatedAt),
                id: nextCursor.lastParentId,
              },
            }
          : undefined;

      const nextParent = await db.comments.findFirst({
        where: {
          parentId: null,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        cursor: parentCursor,
        skip: parentCursor ? 1 : 0,
      });

      if (!nextParent) {
        console.log(`[State 2] No more top-level parents found.`);
        hasMore = false;
        break;
      }
      console.log(`[State 2] Fetched Parent: ${nextParent.id}`);
      hasMore = true;

      result.push(nextParent);
      itemsAdded++;
      nextCursor.lastParentId = nextParent.id;
      nextCursor.lastParentCreatedAt = nextParent.createdAt.toISOString();
      nextCursor.currentParentId = nextParent.id;
      nextCursor.lastReplyId = null;
      nextCursor.lastReplyCreatedAt = null;
      if (itemsAdded === limit) {
        console.log(
          `[State 2] Page filled exactly after adding Parent: ${nextParent.id}. Next cursor points to start of its replies.`
        );

        break;
      }
    }
  }
  let finalNextCursor: string | null = null;

  if (hasMore || itemsAdded === limit) {
    const inputCursorStr = encodeCursor(decodeCursor(cursor)); // Re-encode input for comparison
    const nextCursorStr = encodeCursor(nextCursor);

    if (itemsAdded > 0 && nextCursorStr !== inputCursorStr) {
      finalNextCursor = nextCursorStr;
    } else if (itemsAdded == 0 && hasMore) {
      // Special case: PageSize might be small, we fetched nothing yet but found the first parent exists
      finalNextCursor = encodeCursor(nextCursor);
    }
    return c.json({
      comments: result,
      nextCursor: finalNextCursor,
      totalItemsInPage: itemsAdded,
      totalComments: totalComments,
    });
  }

  return c.json({
    comments: result,
    nextCursor: finalNextCursor,
    totalItemsInPage: itemsAdded,
    totalComments: totalComments,
  });
});

app.get("/comment-with-replis", async (c) => {
  try {
    const cursor = c.req.query("cursor") ?? "";
    const limitParam = c.req.query("limit") ?? "10";
    let limit = parseInt(limitParam);

    // Validate limit
    if (isNaN(limit) || limit <= 0) {
      limit = 10;
    }
    limit = Math.min(limit, 50); // Optional max limit

    // Decode the simplified cursor
    const currentCursor = decodeHierarchicalCursor(cursor);

    // Define the cursor for the Prisma query based on the decoded state
    const prismaCursor =
      currentCursor.lastParentId && currentCursor.lastParentCreatedAt
        ? {
            // Use the composite unique constraint name from the schema
            createdAt_id: {
              createdAt: new Date(currentCursor.lastParentCreatedAt),
              id: currentCursor.lastParentId,
            },
          }
        : undefined;

    // Fetch one extra top-level comment to determine if there's a next page
    const commentsToFetch = limit + 1;

    console.log(
      `Fetching ${commentsToFetch} top-level comments`,
      prismaCursor ? `after cursor ${JSON.stringify(prismaCursor)}` : ""
    );

    // Fetch top-level comments and include nested replies
    const topLevelCommentsData = await db.comments.findMany({
      where: {
        parentId: null, // Only top-level comments
      },
      orderBy: [
        // Consistent ordering is crucial for cursor pagination
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: commentsToFetch,
      cursor: prismaCursor,
      skip: prismaCursor ? 1 : 0, // Skip the cursor item itself if cursor is used
      include: {
        // Include first level of replies
        replies: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          // Optionally limit initial replies shown: take: 5,
          include: {
            // Include second level of replies
            replies: {
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              // include: { replies: { ... } } // Continue nesting as needed
            },
            // Optional: Count replies for the first level replies
            _count: { select: { replies: true } },
          },
        },
        // Optional: Count direct replies for the top-level comment
        _count: { select: { replies: true } },
      },
    });

    // Determine if there are more pages
    let hasMore = topLevelCommentsData.length === commentsToFetch;
    // Slice the results to the requested limit
    const results = hasMore
      ? topLevelCommentsData.slice(0, limit)
      : topLevelCommentsData;

    // Determine the next cursor
    let finalNextCursor: string | null = null;
    if (hasMore && results.length > 0) {
      const lastComment = results[results.length - 1];
      const nextCursorState: HierarchicalPageCursor = {
        lastParentId: lastComment.id,
        lastParentCreatedAt: lastComment.createdAt.toISOString(),
      };
      finalNextCursor = encodeHierarchicalCursor(nextCursorState);
    }

    // Optional: Get total count of top-level comments for pagination UI
    // const totalTopLevelComments = await db.comment.count({ where: { parentId: null } });

    console.log(
      `Returning ${results.length} comments. HasMore: ${hasMore}. NextCursor: ${finalNextCursor}`
    );

    // Return the structured data
    return c.json({
      comments: results, // Array of top-level comments with nested replies
      nextCursor: finalNextCursor,
      // totalTopLevelComments: totalTopLevelComments // Include if needed
    } as HierarchicalPaginatedResponse); // Cast to defined interface
  } catch (error) {
    console.error("Error fetching comments:", error);
    return c.json({ error: "Failed to fetch comments." }, 500);
  }
});

app.get("/dfs", async (c) => {
  try {
    const cursor = c.req.query("cursor") ?? "";
    const limitParam = c.req.query("limit") ?? "10";
    let limit = parseInt(limitParam);

    if (isNaN(limit) || limit <= 0) limit = 10;
    limit = Math.min(limit, 50);

    const currentCursor = decodeDFSCursor(cursor);
    const results: Comments[] = [];
    let itemsAdded = 0;

    // Determine the node *after which* we should start fetching.
    // This node itself was the last item of the previous page.
    let nodeToStartAfter: {
      id: string;
      createdAt: Date;
      parentId: string | null;
    } | null = null;
    if (currentCursor.lastId && currentCursor.lastCreatedAt) {
      nodeToStartAfter = {
        id: currentCursor.lastId,
        createdAt: new Date(currentCursor.lastCreatedAt), // Convert ISO string to Date
        parentId: currentCursor.lastParentId, // This is now string | null
      };
      console.log("Starting DFS after node:", nodeToStartAfter.id);
    } else {
      console.log("Starting DFS from the beginning.");
    }

    // This variable will hold the last node successfully *processed* in the previous iteration
    // It's the input for the *next* call to findNextNodeDFS.
    let lastProcessedNode: {
      id: string;
      createdAt: Date;
      parentId: string | null;
    } | null = nodeToStartAfter;

    while (itemsAdded < limit) {
      // Find the node that comes *after* the last processed node in DFS order
      const nextNode = await findNextNodeDFS(db, lastProcessedNode);

      if (!nextNode) {
        // No more comments found
        break; // Exit the loop
      }

      // Add the found node to the results
      results.push(nextNode);
      itemsAdded++;

      // Update the 'lastProcessedNode' for the next iteration.
      // We need the Date object for the helper function's internal logic.
      lastProcessedNode = {
        id: nextNode.id,
        createdAt: nextNode.createdAt, // Keep as Date object
        parentId: nextNode.parentId,
      };
    } // End while loop

    // --- Determine the final 'nextCursor' value ---
    let finalNextCursor: string | null = null;
    // Create a cursor if the last node processed in this page exists.
    if (lastProcessedNode) {
      // Use the final state of lastProcessedNode
      const nextCursorState: DFSCursor = {
        lastId: lastProcessedNode.id,
        lastCreatedAt: lastProcessedNode.createdAt.toISOString(), // Convert Date back to ISO string for JSON
        lastParentId: lastProcessedNode.parentId,
      };
      const nextCursorStr = encodeDFSCursor(nextCursorState);

      // Avoid returning the exact same cursor if limit=0 or nothing was added
      // Ensure we actually added items OR the cursor state genuinely changed
      if (itemsAdded > 0 || (nextCursorStr && nextCursorStr !== cursor)) {
        // Check if the new cursor is actually different from the input one if itemsAdded is 0
        if (itemsAdded > 0 || nextCursorStr !== cursor) {
          finalNextCursor = nextCursorStr;
        }
      }
    }

    console.log(
      `Returning ${itemsAdded} comments. Next Cursor: ${finalNextCursor}`
    );

    // Always return a response
    return c.json({
      comments: results,
      nextCursor: finalNextCursor,
      totalItemsInPage: itemsAdded,
    } as PaginatedCommentsResponse);
  } catch (error) {
    console.error("Error fetching comments with DFS:", error);
    if (error instanceof Error) {
      console.error(error.message);
      if ("code" in error && typeof error.code === "string")
        console.error(`Prisma Error Code: ${error.code}`);
    }
    return c.json({ error: "Failed to fetch comments." }, 500);
  }
});
export default app;
