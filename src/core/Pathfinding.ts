import { BuildingGraph, GraphLoader, GraphNode } from './GraphLoader';

interface OpenNode {
    id: string;
    f: number;
    g: number;
}

export class Pathfinding {
    private adjacency: Map<string, Array<{ node: string; cost: number }>>;
    private nodes: Map<string, GraphNode>;

    constructor(graph: BuildingGraph) {
        this.adjacency = GraphLoader.buildAdjacencyList(graph);
        this.nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    }

    /** Трёхмерная эвристика (Евклидово расстояние) */
    private heuristic(a: GraphNode, b: GraphNode): number {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /** A* поиск пути. Возвращает список id узлов от start до goal. */
    findPath(startId: string, goalId: string): string[] {
        if (!this.nodes.has(startId) || !this.nodes.has(goalId)) {
            console.warn('[Pathfinding] Start or goal node not found:', { startId, goalId });
            return [];
        }

        if (startId === goalId) return [startId];

        const startNode = this.nodes.get(startId)!;
        const goalNode = this.nodes.get(goalId)!;

        const openSet: OpenNode[] = [
            { id: startId, f: this.heuristic(startNode, goalNode), g: 0 }
        ];
        const cameFrom = new Map<string, string>();
        const gScore = new Map<string, number>();
        gScore.set(startId, 0);

        while (openSet.length > 0) {
            // Простая сортировка — для небольших графов зданий достаточно
            openSet.sort((a, b) => a.f - b.f);
            const current = openSet.shift()!;

            if (current.id === goalId) {
                return this.reconstructPath(cameFrom, current.id);
            }

            for (const { node: neighborId, cost } of this.adjacency.get(current.id) ?? []) {
                const tentativeG = (gScore.get(current.id) ?? Infinity) + cost;

                if (tentativeG < (gScore.get(neighborId) ?? Infinity)) {
                    cameFrom.set(neighborId, current.id);
                    gScore.set(neighborId, tentativeG);
                    const h = this.heuristic(this.nodes.get(neighborId)!, goalNode);
                    const f = tentativeG + h;

                    const existing = openSet.find((n) => n.id === neighborId);
                    if (existing) {
                        existing.f = f;
                        existing.g = tentativeG;
                    } else {
                        openSet.push({ id: neighborId, f, g: tentativeG });
                    }
                }
            }
        }

        console.warn('[Pathfinding] No path found from', startId, 'to', goalId);
        return [];
    }

    private reconstructPath(cameFrom: Map<string, string>, current: string): string[] {
        const path: string[] = [current];
        let cursor = current;
        while (cameFrom.has(cursor)) {
            cursor = cameFrom.get(cursor)!;
            path.unshift(cursor);
        }
        return path;
    }

    getNodeById(id: string): GraphNode | null {
        return this.nodes.get(id) ?? null;
    }

    getAllNodes(): GraphNode[] {
        return Array.from(this.nodes.values());
    }
}
