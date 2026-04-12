module common {
    // Types of messages the engine can send, for simplicity we don't distinguish
    // between control messages and pdata messages right now.
    type Message = 
        PdataMessage(Pdata)
        | AckMessage(Context)
        | NackMessage(Context)
        | TimerTickMessage

    // Types of effects that a node can apply
    type Effect =
        SendPdata(Pdata)
        | NotifyAck(Context)
        | NotifyNack(Context)

    type Pdata = {
        context: Context,
        payload: Set[Chunk]
    }

    type Context = int
    type Data = int
    type Chunk = Aggregable(Data) | NotAggregable(Data)
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
        val _crash = if (k == -1) Map().get(0) else 0
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
        context: Context,
        flushed: bool,
        pending: int,
    }

    type PendingData = {
        data: Set[Data],
        in_keys: Set[slot_map::SlotKey]
    }

    type Processor = {
        inbound: slot_map::SlotMap[InboundTracker],
        pending: PendingData,
        outbound: slot_map::SlotMap[Set[SlotKey]],
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
        // Type checker/LSP also doesn't catch wrong names in the patterns here
        match m {
            | PdataMessage(pd) => process_pdata(p, pd)
            | AckMessage(c) => process_ack(p, c)
            | NackMessage(c) => process_nack(p, c)
            | TimerTickMessage => flush(p)
        }
    }
    
    // TODO: Cap the amount of data in pending to 2 so we can model the case
    // where it's just too big
    pure def process_pdata(p: Processor, pd: Pdata): Set[Transition] = {
        val aggregable_data = pd.payload.fold(Set(), (acc, chunk) => 
            match (chunk) {
                | Aggregable(d) => acc.union(Set(d))
                | NotAggregable(_) => acc
            })
        val non_aggregable_data = pd.payload.fold(Set(), (acc, chunk) => 
            match (chunk) {
                | Aggregable(_) => acc
                | NotAggregable(d) => acc.union(Set(d))
            })

        val pending_acks = if (non_aggregable_data.size() > 0) 1 else 0
        val (inbound, in_key) = slot_map::alloc(p.inbound, {flushed: false, pending: pending_acks, context: pd.context})

        val has_agg = aggregable_data.size() > 0
        val has_non_agg = non_aggregable_data.size() > 0
        if (has_agg and has_non_agg) {
            // Both aggregable and not aggregable data
            val (outbound, out_key) = slot_map::alloc(p.outbound, Set(in_key))
            val transition = {
                proc: {
                    ...p,
                    inbound: inbound,
                    pending: {
                        data: p.pending.union(aggregable_data),
                        in_keys: p.pending.in_keys.union(Set(in_key))
                    }, 
                    outbound: outbound
                },
                effects: SendPdata({context: out_key, data: non_aggregable_data})
            }
            Set(transition)
        } else if (has_agg and not(has_non_agg)) {
            val transition = {
                proc: {
                    ...p,
                    inbound: inbound,
                    pending: {
                        data: p.pending.union(aggregable_data),
                        in_keys: p.pending.in_keys.union(Set(in_key))
                    }
                },
                effects: Set() 
            }

            Set(transition)
        } else if (not(has_agg) and has_non_agg) {
            // Panic, we're not allowing for this case because we'd have to
            // model the interests stack where acks can skip over this component.
            // Maybe we could do that in the future
            Map().get(1)
        } else {
            // Panic, should be unreachable. We're not testing with empty
            // batches, but we could add that later.
            Map().get(1)
        }
    }
    
    pure def flush(p: Processor): Set[Transition] = {
        if (p.pending.size() == 0) Set()
        else {
            val (outbound, out_key) = slot_map::alloc(p.outbound, p.pending.in_keys)
            val inbound = slot_map::map_some(
                p.inbound,
                (id, _) => p.pending.contains(id),
                tr => { flushed: true, pending: tr.pending + 1}
            )
            val out_data = p.pending.data.map(d => Aggregable(d))
            val transition = {
                proc: {
                    ...p,
                    pending: {data: Set(), in_keys: Set()},
                    inbound: inbound,
                    outbound: outbound
                },
                effects: Set(SendPdata({context: out_key, data: out_data})),
            }

            Set(transition)
        }
    }
 
    pure def process_nack(p: Processor, c: Context): Set[Transition] = {
        val out_key = c;
        if (not(slot_map::has_data(p.outbound, out_key))) Set()
        else {
            val inbounds = slot_map::must_get(p.outbound, out_key)
            val nack_keys = inbounds.filter(in_key => slot_map::has_data(p.inbound, in_key))
            val nack_contexts = nack_keys.map(in_key =>  slot_map::must_get(in_key).context)
            Set({
                proc: {
                    ...p,
                    inbound: slot_map::free_many(p.inbound, nack_keys),
                    outbound: slot_map::free(p.outbound, out_key)
                },
                effects: nack_contexts.fold(Set(), (acc, c) => acc.union(Set(NotifyNack(c))))
            })
        }
    }

    pure def process_ack(p: Processor, c: Context): Set[Transition] = {
        val out_key = c;
        if (not(slot_map::has_data(p.outbound, out_key))) Set()
            else {
                val new_proc = apply_ack(p, out_key)
                val in_keys = collect_acks(new_proc)
                val ack_contexts = in_keys.map(in_key => slot_map::must_get(in_key).context)
                val inbound = slot_map::free_many(new_proc.inbound, in_keys)
                Set({
                    proc: { ...new_proc, inbound: inbound },
                    effects: ack_contexts.fold(Set(), (acc, c) => acc.union(Set(NotifyAck(c))))
                })
            }
    }

    pure def apply_ack(p: Processor, out_key: slot_map::SlotKey): Processor = {
        if (not(slot_map::has_data(p.outbound, out_key))) p
        else {
            val inbounds = slot_map::must_get(p.outbound, out_key)
            val new_inbound = inbounds.fold(p.inbound,
                (acc, key) => slot_map::update(acc, key, tr => {...tr, pending: tr.pending - 1})
            )

            { 
                ...p,
                inbound: new_inbound,
                outbound: slot_map::free(p.outbound, out_key)
            }
        }
    }

    pure def collect_acks(p: Processor): Set[Context] = {
        slot_map::find_keys(p.inbound, tr => and ( tr.flushed == true, tr.pending == 0))
    }
}

module acknack3 {
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
        proc_acked: Set[Batch],
        // The number of times the processor has nacked each batch.
        proc_nacked: Set[Batch],
        // The processor under test
        proc: Processor,
    }

    var s: AckNackState

    action init: bool = all {
        s' = {
            proc: new_processor(5),
            next_pdata:  0,
            received:    Set(),
            acked:       Set(),
            nacked:      Set(),
            proc_acked:  Set(),
            proc_nacked: Set()
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
            | NotifyAck(b)  => { ...acc, proc_acked:  acc.proc_acked.union(Set(b))  }
            | NotifyNack(b) => { ...acc, proc_nacked: acc.proc_nacked.union(Set(b)) }
        })
        { ...new_s, proc: t.proc }
    }

    action send_pdata: bool = {
        val transitions = process(s.proc, Pdata(s.next_pdata))
        nondet transition = transitions.oneOf()
        val new_s = apply_transition(s, transition)

        all {
            s.next_pdata < 4,
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
