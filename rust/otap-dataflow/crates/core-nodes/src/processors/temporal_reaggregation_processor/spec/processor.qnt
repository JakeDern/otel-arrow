module slot_map {
    type SlotMap[k, v] = {
        map: k -> v,
        cap: int
    }

    pure def new(cap: int): SlotMap[k, v] = {
        { map: Map(), cap: cap }
    }

    pure def remaining_cap(m: SlotMap[k, v]): int =
        m.cap - m.map.keys().size()

    pure def has_cap(m: SlotMap[k, v]): bool =
        remaining_cap(m) > 0

    pure def insert(m: SlotMap[k, v], k: k, v: v): SlotMap[k, v] =
        { ...m, map: m.map.put(k, v) }

    pure def size_less_than_cap(m: SlotMap): bool = remaining_cap(m) > 0
}

module processor {
    import slot_map.*

    type Batch = int

    type InboundTracker = {
        batch: Batch,
        flushed: bool,
        tracker: bool,
    }
    type InboundMap = SlotMap[Batch, InboundTracker]
    type OutboundMap = SlotMap[Batch, Set[Batch]]

    type Processor = {
        inbound: InboundMap,
        pending: Set[Batch],
        outbound: OutboundMap,
    }

    var processor: Processor

    val state = { processor: processor }

    action init: bool = all {
        processor' = {
            inbound: new(16),
            pending: Set(),
            outbound: new(16)
        }
    }
}
