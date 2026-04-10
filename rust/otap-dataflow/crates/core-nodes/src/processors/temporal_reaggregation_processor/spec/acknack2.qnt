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
    import basicSpells.* from "spells/basicSpells"

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

    pure def remove_many(m: SlotMap[k, v], s: Set[k]): SlotMap[k, v] = {
        { ...m, map: s.fold(m.map, (acc, key) => mapRemove(acc, key))}
    }

    pure def insert(m: SlotMap[k, v], k: k, v: v): SlotMap[k, v] =
        { ...m, map: m.map.put(k, v) }

    pure def size_less_than_cap(m: SlotMap[k, v]): bool = remaining_cap(m) >= 0
}

module processor {
    import common.*
    import slot_map
    import basicSpells.* from "spells/basicSpells"

    type InboundTracker = {
        flushed: bool,
        pending: int
    }

    type Processor = {
        inbound: slot_map::SlotMap[Batch, InboundTracker],
        pending: Set[Batch],
        outbound: slot_map::SlotMap[Batch, Set[Batch]],
        outbound_batch: Batch
    }

    type Transition = {
       proc: Processor,
       effects: List[Effect]
    }

    pure def new_processor(cap: int): Processor = {
        {
            inbound: slot_map::new(cap),
            pending: Set(),
            outbound: slot_map::new(cap),
            outbound_batch: 0
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
        val transition = {
            proc: {
                ...p,
                pending: Set(),
                inbound: p.pending.fold(p.inbound, (acc, i) => {
                    if (not(acc.map.has(i))) acc
                    else {
                        val current = acc.map.get(i)
                        slot_map::insert(acc, i, { flushed: true, pending: current.pending + 1 })
                    }
                }),
                outbound_batch: p.outbound_batch + 1,
                outbound: slot_map::insert(p.outbound, p.outbound_batch, p.pending),
            },
            effects: List(SendPdata(p.outbound_batch)),
        }

        Set(transition)
    }

    pure def process_pdata(p: Processor, b: Batch): Set[Transition] = {
        Set(process_pdata_partial(p, b), process_pdata_full(p, b)).flatten()
    }

    pure def process_pdata_full(p: Processor, b: Batch): Set[Transition] = {
        val transition = {
            proc: {
               ...p,
               inbound: slot_map::insert(p.inbound, b, {flushed: false, pending: 0}),
               pending: p.pending.union(Set(b))
            },
            effects: List()
        }

        Set(transition)
    }

    
    pure def process_nack(p: Processor, b: Batch): Set[Transition] = {
        val nacks = if (not(p.outbound.map.has(b))) Set()
        else {
            val inbounds = p.outbound.map.get(b)
            inbounds.filter(i => p.inbound.map.has(i))
        }
        
        val transition = {
            proc: {
                ...p,
                inbound: slot_map::remove_many(p.inbound, nacks)   
            },
            effects: nacks.fold(List(), (acc, b) => acc.append(NotifyNack(b)))
        }

        Set(transition)
    }

    pure def process_ack(p: Processor, b: Batch): Set[Transition] = {
        val new_proc = apply_ack(p, b)
        val acks = collect_acks(new_proc)
        val inbound = slot_map::remove_many(new_proc.inbound, acks)
        val transition = {
            proc: { ...new_proc, inbound: inbound },
            effects: acks.fold(List(), (acc, b) => acc.append(NotifyAck(b)))
        }
        
        Set(transition)
    }

    pure def process_pdata_partial(p: Processor, b: Batch): Set[Transition] = {
        val transition = {
            proc: {
                ...p,

                // Track the inbound
                inbound: slot_map::insert(p.inbound, b, {flushed: false, pending: 1}),
                pending: p.pending.union(Set(b)),
                
                // Also track the passthrough
                outbound: slot_map::insert(p.outbound, p.outbound_batch, Set(b)), 
                outbound_batch: p.outbound_batch + 1
            },
            effects: List(SendPdata(p.outbound_batch))
        }

        Set(transition)
    }

    pure def apply_ack(p: Processor, b: Batch): Processor = {
        if (not(p.outbound.map.has(b))) p
        else {
            val inbounds = p.outbound.map.get(b)
            val new_inbound = inbounds.fold(p.inbound, (acc, i) => {
                if (not(acc.map.has(i))) acc
                else {
                    val current = acc.map.get(i)
                    slot_map::insert(acc, i, { ...current, pending: current.pending - 1 })
                }
            })

            { 
                ...p,
                inbound: new_inbound,
                outbound: {...p.outbound, map: p.outbound.map.mapRemove(b)}
            }
        }
    }

    pure def collect_acks(p: Processor): Set[Batch] = {
        p.inbound.map.keys().filter(k => {
            val tracker = p.inbound.map.get(k)
            tracker.flushed == true and tracker.pending == 0
        })
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
            proc: new_processor(8),
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
        val new_s = t.effects.foldl(s, (acc, e) =>
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
        nondet batch = s.received.oneOf()
        send_ack(batch)
    }

    action nack_step(): bool = {
        nondet batch = s.received.oneOf()
        send_nack(batch)
    }

    action send_ack(b: Batch): bool = {
        val transitions = process(s.proc, Ack(b))
        nondet transition = transitions.oneOf()
        s' = apply_transition(s, transition) 
    }

    action send_nack(b: Batch): bool = all {
        val transitions = process(s.proc, Nack(b))
        nondet transition = transitions.oneOf()
        s' = apply_transition(s, transition)
    }

    action send_timer_tick: bool = all {
        val transitions = process(s.proc, TimerTick)
        nondet transition = transitions.oneOf()
        s' = apply_transition(s, transition)
    }
}
