export interface GraphNode {
    id: string;
    x: number;
    y: number;
    z: number;
    type: 'entrance' | 'hallway' | 'corridor' | 'room';
    label?: string;
}

export interface GraphEdge {
    from: string;
    to: string;
    cost: number;
    bidirectional: boolean;
}

export interface BuildingGraph {
    metadata: {
        building: string;
        floor: number;
        created: string;
        description?: string;
    };
    nodes: GraphNode[];
    edges: GraphEdge[];
}

export class GraphLoader {
    static async load(url: string): Promise<BuildingGraph> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: Failed to load graph from ${url}`);
        }
        const data = (await response.json()) as BuildingGraph;
        console.log(`[GraphLoader] Loaded ${data.nodes.length} nodes, ${data.edges.length} edges`);
        return data;
    }

    static buildAdjacencyList(
        graph: BuildingGraph
    ): Map<string, Array<{ node: string; cost: number }>> {
        const adj = new Map<string, Array<{ node: string; cost: number }>>();

        for (const node of graph.nodes) {
            adj.set(node.id, []);
        }

        for (const edge of graph.edges) {
            adj.get(edge.from)!.push({ node: edge.to, cost: edge.cost });
            if (edge.bidirectional) {
                adj.get(edge.to)!.push({ node: edge.from, cost: edge.cost });
            }
        }

        return adj;
    }

    static findNodeByLabel(graph: BuildingGraph, label: string): GraphNode | null {
        const normalized = label.trim().toLowerCase();
        return (
            graph.nodes.find((n) => n.label?.toLowerCase() === normalized) ?? null
        );
    }
}
