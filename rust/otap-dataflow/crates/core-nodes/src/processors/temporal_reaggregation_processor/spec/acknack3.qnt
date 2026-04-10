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
    type SlotKey = int

    type SlotMap[v] = {
        map: SlotKey -> v,
        free: Set[SlotKey]
    }

    pure def new(cap: int): SlotMap[v] = {
        { map: Map(), free: 0.to(cap - 1) }
    }

    pure def remaining_cap(m: SlotMap[v]): int = m.free.size()

    pure def has_cap(m: SlotMap[v]): bool = m.free.size() > 0

    pure def alloc(m: SlotMap[v], v: v): (SlotMap[v], SlotKey) = {
        val k = m.free.fold(-1, (acc, x) => if (acc == -1) x else acc)
        ({ map: m.map.put(k, v), free: m.free.exclude(Set(k)) }, k)
    }

    pure def insert(m: SlotMap[v], k: SlotKey, v: v): SlotMap[v] =
        { ...m, map: m.map.put(k, v) }

    pure def free(m: SlotMap[v], k: SlotKey): SlotMap[v] = {
        val newMap = m.map.keys().fold(Map(), (acc, key) =>
            if (key == k) acc else acc.put(key, m.map.get(key))
        )
        { map: newMap, free: m.free.union(Set(k)) }
    }

    pure def free_many(m: SlotMap[v], ks: Set[SlotKey]): SlotMap[v] =
        ks.fold(m, (acc, k) => free(acc, k))

    pure def must_get(m: SlotMap[v], k: SlotKey): v = m.map.get(k)

    pure def has_data(m: SlotMap[v], k: SlotKey): bool = m.map.keys().contains(k)

    pure def find_keys(m: SlotMap[v], pred: v => bool): Set[SlotKey] =
        m.map.keys().filter(k => pred(m.map.get(k)))

    pure def update(m: SlotMap[v], k: SlotKey, fn: v => v): SlotMap[v] =
        if (m.map.keys().contains(k)) { ...m, map: m.map.put(k, fn(m.map.get(k))) }
        else m

    pure def map_some(m: SlotMap[v], pred: (SlotKey, v) => bool, transform: v => v): SlotMap[v] =
        m.map.keys().fold(m, (acc, k) => {
            val v = acc.map.get(k)
            if (pred(k, v)) { ...acc, map: acc.map.put(k, transform(v)) }
            else acc
        })
}

module processor {
    import common.*
    import slot_map
    import slot_map.SlotKey
    import basicSpells.* from "spells/basicSpells"

    type InboundTracker = {
        flushed: bool,
        pending: int
    }

    type Processor = {
        inbound: slot_map::SlotMap[InboundTracker],
        pending: Set[slot_map::SlotKey],
        outbound: slot_map::SlotMap[Set[Batch]],
    }

    type Transition = {
       proc: Processor,
       effects: Set[Effect]
    }

    pure def new_processor(cap: int): Processor = {
        {
            inbound:  { map: Map(), free: 0.to(cap - 1) },
            pending:  Set(),
            outbound:  { map: Map(), free: 0.to(cap - 1) },
        }
    }

    pure def accept_pdata(p: Processor): bool = {
        slot_map::has_cap(p.inbound) and slot_map::remaining_cap(p.outbound) >= 2
    }

    pure def process(p: Processor, m: Message): Set[Transition] = {
        match m {
            | Pdata(b) => process_pdata(p, b)
            | Ack(b) => process_ack(p, b)
            | Nack(b) => process_nack(p, b)
            | TimerTick => flush(p)
        }
    }
    
    pure def flush(p: Processor): Set[Transition] = {
        if (p.pending.size() == 0) {
            Set({ proc: p, effects: Set()})
        } else {
            val (outbound, key) = slot_map::alloc(p.outbound, p.pending)
            val inbound = slot_map::map_some(
                p.inbound,
                (id, _) => p.pending.contains(id),
                tr => { flushed: true, pending: tr.pending + 1}
            )
            val transition = {
                proc: {
                    ...p,
                    pending: Set(),
                    inbound: inbound,
                    outbound: outbound
                },
                // TODO: We're casting SlotKey to Batch here, maybe it's time to model pdata properly
                // with calldata and batch
                effects: Set(SendPdata(key)),
            }

            Set(transition)
        }
    }

    pure def process_pdata(p: Processor, b: Batch): Set[Transition] = {
        process_pdata_partial(p, b).union(process_pdata_full(p, b))
    }

    pure def process_pdata_full(p: Processor, b: Batch): Set[Transition] = {
        val (inbound, key) = slot_map::alloc(p.inbound, {flushed: false, pending: 0})
        val transition = {
            proc: {
               ...p,
               inbound: inbound,
               pending: p.pending.union(Set(key))
            },
            effects: Set()
        }

        Set(transition)
    }

    pure def process_pdata_partial(p: Processor, b: Batch): Set[Transition] = {
        val (inbound, in_key) = slot_map::alloc(p.inbound, {flushed: false, pending: 1})
        val (outbound, out_key) = slot_map::alloc(p.outbound, Set(in_key))
        val transition = {
            proc: {
                ...p,

                // Track the inbound
                inbound: inbound,
                pending: p.pending.union(Set(in_key)),
                
                // Also track the passthrough
                outbound: outbound
            },
            // TODO: Same thing here, we're kind of casting Key to batch which
            // is meh :(
            effects: Set(SendPdata(out_key))
        }

        Set(transition)
    }

    
    pure def process_nack(p: Processor, b: Batch): Set[Transition] = {
        if (not(slot_map::has_data(p.outbound, b))) Set()
        else {
            val inbounds = slot_map::must_get(p.outbound, b)
            val nacks = inbounds.filter(i => slot_map::has_data(p.inbound, i))
            Set({
                proc: {
                    ...p,
                    inbound: slot_map::free_many(p.inbound, nacks),
                    outbound: slot_map::free(p.outbound, b)
                },
                effects: nacks.fold(Set(), (acc, b) => acc.union(Set(NotifyNack(b))))
            })
        }
    }

    pure def process_ack(p: Processor, b: Batch): Set[Transition] = {
        if (not(slot_map::has_data(p.outbound, b))) Set()
            else {
                val new_proc = apply_ack(p, b)
                val acks = collect_acks(new_proc)
                val inbound = slot_map::free_many(new_proc.inbound, acks)
                Set({
                    proc: { ...new_proc, inbound: inbound },
                    effects: acks.fold(Set(), (acc, b) => acc.union(Set(NotifyAck(b))))
                })
            }
    }


    pure def apply_ack(p: Processor, b: Batch): Processor = {
        if (not(slot_map::has_data(p.outbound, b))) p
        else {
            val inbounds = slot_map::must_get(p.outbound, b)
            val new_inbound = inbounds.fold(p.inbound,
                (acc, key) => slot_map::update(acc, key, tr => {...tr, pending: tr.pending - 1})
            )

            { 
                ...p,
                inbound: new_inbound,
                outbound: slot_map::free(p.outbound, b)
            }
        }
    }

    pure def collect_acks(p: Processor): Set[Batch] = {
        slot_map::find_keys(p.inbound, tr => and ( tr.flushed == true, tr.pending == 0))
    }
}

module acknack {
    import common.*
    import slot_map
    import basicSpells.* from "spells/basicSpells"
    import processor.*

    type AckNackState = {
        // The id of the next pdata to send.
        next_pdata: Batch,
        // The batches we have sent acks or nacks to the processor for.
        acked: Set[Batch],
        // The batches we have sent nacks to the processor for.
        nacked: Set[Batch],
        // The batches the processor has sent out.
        received: Set[Batch],
        // The number of times the processor has acked each batch.
        proc_acked: Batch -> int,
        // The number of times the processor has nacked each batch.
        proc_nacked: Batch -> int,
        // The processor under test
        proc: Processor,
    }

    var s: AckNackState

    action init: bool = all {
        s' = {
            proc: new_processor(4),
            next_pdata:  0,
            received:    Set(),
            acked:       Set(),
            nacked:      Set(),
            proc_acked:  Map(),
            proc_nacked: Map(),
        }
    }

    action step: bool = {
        any {
            send_pdata,
            send_timer_tick,
            ack_step,
            nack_step
        }
    }

    pure def apply_transition(s: AckNackState, t: Transition): AckNackState = {
        val new_s = t.effects.fold(s, (acc, e) =>
            match e {
            | SendPdata(b)  => { ...acc, received:    acc.received.union(Set(b))    }
            | NotifyAck(b)  => { ...acc, proc_acked:  acc.proc_acked.setByWithDefault(b, v => v + 1, 0)  }
            | NotifyNack(b) => { ...acc, proc_nacked: acc.proc_nacked.setByWithDefault(b, v => v + 1, 0) }
        })
        { ...new_s, proc: t.proc }
    }

    action send_pdata: bool = {
        val transitions = process(s.proc, Pdata(s.next_pdata))
        nondet transition = transitions.oneOf()
        val new_s = apply_transition(s, transition)

        all {
            s.next_pdata < 2,
            accept_pdata(s.proc),
            s' = { ...new_s, next_pdata: new_s.next_pdata + 1 }
        }
    }

    action ack_step(): bool = {
        nondet batch = s.received.exclude(s.acked).oneOf()
        send_ack(batch)
    }

    action nack_step(): bool = {
        nondet batch = s.received.exclude(s.nacked).oneOf()
        send_nack(batch)
    }

    action send_ack(b: Batch): bool = {
        val transitions = process(s.proc, Ack(b))
        nondet transition = transitions.oneOf()
        val new_s = apply_transition(s, transition) 
        all {
            s' = { ...new_s, acked: s.acked.union(Set(b))}
        }
    }

    action send_nack(b: Batch): bool = {
        val transitions = process(s.proc, Nack(b))
        nondet transition = transitions.oneOf()
        val new_s = apply_transition(s, transition)
        all {
            s' = { ...new_s, nacked: s.nacked.union(Set(b))}
        }
    }

    action send_timer_tick: bool = {
        val transitions = process(s.proc, TimerTick)
        nondet transition = transitions.oneOf()
        all {
            s.proc.pending.size() > 0,
            s' = apply_transition(s, transition)
        }
    }
}
