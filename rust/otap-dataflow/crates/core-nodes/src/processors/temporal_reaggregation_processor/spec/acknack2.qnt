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
    type Option[t] = Some(t) | None

    pure def unwrap(value: Option[t]): t = {
        match value {
        | None => Map().get(value)
        | Some(x) => x
        }
    }

    pure def map_option(o: Option[t], fn: t => t): Option[t] = {
        match o {
            | Some(v) => Some(fn(v))
            | None => None
        }
    }

    type Slot[t] = {
        id: SlotKey,
        data: Option[t], 
    } 

    type SlotMap[t] = Set[Slot[t]]
    type SlotKey = int

    pure def new(cap: int): SlotMap[t] = {
        0.to(cap - 1).map(x => { id: x, data: None })
    }

    pure def find_free(m: SlotMap[t]): Slot[t] = {
        m.fold(None, (acc, s) => {
            match acc {
                | Some(_) => acc
                | None => match s.data {
                    | Some(_) => None
                    | None => Some(s)
                    }
                }
            }).unwrap()
    }

    pure def count_free(m: SlotMap[t]): SlotKey = {
        m.fold(0, (acc, s) => match s.data { | None => acc + 1 | Some(_) => acc })
    }

    pure def alloc(m: SlotMap[t], v: t): (SlotMap[t], SlotKey) = {
        val slot = m.find_free()
        (m.map(s => if (s.id == slot.id) { ...s, data: Some(v) } else s), slot.id) 
    }

    pure def update(m: SlotMap[t], k: SlotKey, fn: t => t): SlotMap[t] = {
       m.map(s => if (s.id == k) { ...s, data: s.data.map_option(fn) } else s)
    }

    pure def free(m: SlotMap[t], k: SlotKey): SlotMap[t] = {
        m.map(s => if (s.id == k) { ...s, data: None } else s) 
    }

    pure def free_many(m: SlotMap[t], k: Set[SlotKey]): SlotMap[t] = {
        k.fold(m, (acc, k) => free(acc, k))
    }

    // Apply the transform to occupied slots in the map which match the predicate
    pure def map_some(m: SlotMap[t], pred: (SlotKey, t) => bool, transform: (t) => t): SlotMap[t] = {
        m.map(s => {
            match s.data {
                | None => s
                | Some(t) => if (pred(s.id, t)) { ...s, data: Some(transform(t)) } else s
                }
        }) 
    }
    
    pure def find(m: SlotMap[t], pred: t => bool): Set[t] = {
        m.fold(Set(), (acc, slot) => {
            match slot.data {
                    | None => acc
                    | Some(d) => if (pred(d)) { acc.union(Set(d)) } else acc
                }
        })
    }

    pure def find_keys(m: SlotMap[t], pred: t => bool): Set[SlotKey] = {
        m.fold(Set(), (acc, slot) => {
            match slot.data {
                    | None => acc
                    | Some(d) => if (pred(d)) { acc.union(Set(slot.id)) } else acc
                }
        })
    }

    pure def must_get(m: SlotMap[t], k: SlotKey): t = {
        m.get_data(k).unwrap()
    }
    
    pure def get_data(m: SlotMap[t], k: SlotKey): Option[t] = {
        m.fold(None, (acc, s) => if (s.id == k) s.data else acc)
    }

    pure def has_data(m: SlotMap[t], k: SlotKey): bool = {
        match m.get_data(k) { | Some(_) => true | None => false }
    }

    pure def remaining_cap(m: SlotMap[t]): int = m.count_free()

    pure def has_cap(m: SlotMap[t]): bool = m.count_free() > 0
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
            inbound:        slot_map::new(cap),
            pending:        Set(),
            outbound:       slot_map::new(cap)
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
        val nacks = if (not(slot_map::has_data(p.outbound, b))) Set()
        else {
            val inbounds = slot_map::must_get(p.outbound, b)
            inbounds.filter(i => slot_map::has_data(p.inbound, i))
        }
        
        val transition = {
            proc: {
                ...p,
                inbound: slot_map::free_many(p.inbound, nacks),
                outbound: slot_map::free(p.outbound, b)
            },
            effects: nacks.fold(Set(), (acc, b) => acc.union(Set(NotifyNack(b))))
        }

        Set(transition)
    }

    pure def process_ack(p: Processor, b: Batch): Set[Transition] = {
        val new_proc = apply_ack(p, b)
        val acks = collect_acks(new_proc)
        val inbound = slot_map::free_many(new_proc.inbound, acks)
        val transition = {
            proc: { ...new_proc, inbound: inbound },
            effects: acks.fold(Set(), (acc, b) => acc.union(Set(NotifyAck(b))))
        }
        
        Set(transition)
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
