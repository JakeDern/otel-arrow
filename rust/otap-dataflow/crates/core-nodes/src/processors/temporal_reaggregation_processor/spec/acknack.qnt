module common {
    type Batch = int
}

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

    pure def size_less_than_cap(m: SlotMap[k, v]): bool = remaining_cap(m) >= 0
}

module engine {
    import common.*

    type ControlMessage = 
        Ack(Batch) 
        |Nack(Batch)

    type PdataMessage = Pdata(Batch)
}

module processor {
    import common.*
    import slot_map

    type InboundTracker = {
        batch: Batch,
        flushed: bool,
        tracker: bool,
    }

    type InboundMap = slot_map::SlotMap[Batch, InboundTracker]
    type OutboundMap = slot_map::SlotMap[Batch, Set[Batch]]

    type Processor = {
        inbound: InboundMap,
        pending: Set[Batch],
        outbound: OutboundMap,
    }

    pure def new(cap: int): Processor = {
        {
            // TODO: Figure out how big to make these
            inbound: slot_map::new(cap),
            pending: Set(),
            outbound: slot_map::new(cap)
        } 
    }

    pure def accept_pdata(p: Processor): bool = {
        slot_map::has_cap(p.inbound) and slot_map::remaining_cap(p.outbound) >= 2
    }
}

module acknack {
    import common.*
    import engine.*
    import processor
    import slot_map

    var proc: processor::Processor
    var received: Set[Batch]
    var acked: Set[Batch]
    var nacked: Set[Batch]

    val state = { 
        processor: proc,
        received: received,
        acked: acked,
        nacked: nacked
    }

    action init: bool = {
        nondet cap = oneOf(2.to(16))

        all {
            proc' = processor::new(cap),
            received' = Set(),
            acked' = Set(),
            nacked' = Set(),
        }
    }

    action receive_pdata(p: PdataMessage): bool = {
        val b = match p { | Pdata(b) => b }
        
        all {
            processor::accept_pdata(proc),
            not(received.contains(b)),
            received' = received.union(Set(b)),
            acked' = acked,
            nacked' = nacked,
        }
    }

    pure val BATCHES: Set[Batch] = 0.to(2^16)

    action step: bool = {
        nondet batch = BATCHES.exclude(received).oneOf()

        any {
            receive_pdata(Pdata(batch))
        }
    }

    // action process_split(p: PdataMessage): bool = all {
    //
    // }
    //
    // action process_aggregate(p: PdataMessage): bool = all {
    //
    // }
    //
    // action process_passthrough(p: PdataMessage): bool = all {
    //
    // }
}
