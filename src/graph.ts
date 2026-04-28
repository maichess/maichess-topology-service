interface Node {
  id: string;
  label: string;
}

interface Edge {
  id: string;
  source: string;
  target: string;
}

const nodes = new Map<string, Node>();
const edges = new Map<string, Edge>();

export function addNode(id: string): void {
  if (!nodes.has(id)) {
    nodes.set(id, { id, label: id });
  }
}

export function addEdge(source: string, target: string): void {
  const id = `${source}->${target}`;
  if (!edges.has(id)) {
    edges.set(id, { id, source, target });
  }
}

export function getGraph(): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  };
}
