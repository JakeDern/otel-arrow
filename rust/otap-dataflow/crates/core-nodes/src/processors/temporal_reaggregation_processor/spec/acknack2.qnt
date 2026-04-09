module common {
    // Batch is just an integer id representing a particular batch of pdata
    type Batch = int

    // Types of messages the engine can send, for simplicity we don't distinguish
    // between control messages and pdata messages right now.
    type Message = 
        Pdata(Batch)
        |Ack(Batch)
        |Nack(Batch)
        |TimerTick

    // Types of effects that a node can apply
    type Effect =
        SendPdata(Batch)
        | NotifyAck(Batch)
        | NotifyNack(Batch)
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

module processor {
    import common.*
    import slot_map

    type InboundTracker = {
        flushed: bool,
        pending_acks: int
    }

    const INBOUND_CAP: int
    const OUTBOUND_CAP: int
    const outbox: List[Effect]

    var inbound: slot_map::SlotMap[Batch, InboundTracker]
    var pending: Set[Batch]
    var outbound: slot_map::SlotMap[Batch, Set[Batch]]

    val state = {
        inbound: inbound,
        pending: pending,
        outbound: outbound
    }

    def accept_pdata(): bool = {
        slot_map::has_cap(inbound) and slot_map::remaining_cap(outbound) >= 2
    }
}

module acknack {
    import common.*
    import processor
    import slot_map

    var received: Set[Batch] // Can we just make this an integer?
    var acked: Set[Batch]
    var nacked: Set[Batch]

    var outbox: List[Effect]
    import processor(outbox = outbox) as proc1

    val state = { 
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

    action step: bool = {
        // Pick batch 0, 1, 2, ...
        val batch: Batch = received.size()
        nondet ack_nack_batch: Batch = received.oneOf()

        any {
            send_pdata(batch),

        }
    }

    action send_pdata(p: Batch): bool = {
        all {
            // Can only do this 
            processor::accept_pdata(proc),
            received' = received.union(Set(p)),
            proc' = proc,
            acked' = acked,
            nacked' = nacked,
        }
    }
}
