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

    pure def extract_data(pd: Pdata): Set[Data] = {
        pd.payload.fold(Set(), (acc, chunk) => {
            match (chunk){
                | Aggregable(d) => acc.union(Set(d))
                | NotAggregable(d) => acc.union(Set(d))
            }
        })
    }

    pure def extract_aggregable_data(pd: Pdata): Set[Data] = {
        pd.payload.fold(Set(), (acc, chunk) => {
            match (chunk){
                | Aggregable(d) => acc.union(Set(d))
                | NotAggregable(_) => acc
            }
        })
    }

    pure def extract_non_aggregable_chunks(pd: Pdata): Set[Chunk] = {
        pd.payload.fold(Set(), (acc, chunk) => {
            match (chunk){
                | Aggregable(_) => acc
                | NotAggregable(d) => acc.union(Set(NotAggregable(d)))
            }
        })
    }

    type Context = int
    type Data = int
    type Chunk = Aggregable(Data) | NotAggregable(Data)
}

module slot_map {
    type SlotKey = int

    type Option[t] = Some(t) | None

    pure def unwrap(o: Option[t]): t = {
        match (o) {
        | Some(x) => x
        | None => Map().get(o)
        }
    }

    pure def is_none(o: Option[t]): bool = {
        match (o) {
        | Some(_) => false
        | None => true
        }
    }

    pure def is_some(o: Option[t]): bool = {
        match (o) {
        | Some(_) => true
        | None => false
        }
    }

    type SlotMap[v] = {
        slots: List[Option[v]],
        cap: int
    }

    pure def new(cap: int): SlotMap[v] = {
        val slots = 1.to(cap).fold(List(), (acc, _) => acc.append(None))
        { slots: slots, cap: cap }
    }

    pure def remaining_cap(m: SlotMap[v]): int = m.count_free()

    pure def count_free(m: SlotMap[v]): int = 
        m.slots.foldl(0, (acc, s) => match (s) { | None => acc + 1 | Some(_) => acc })

    pure def has_cap(m: SlotMap[v]): bool = m.count_free() > 0

    pure def alloc(m: SlotMap[v], v: v): (SlotMap[v], SlotKey) = {
        val idx = m.slots.indices().fold(-1, (acc, i) => {
            if (acc != -1) acc
            else match (m.slots[i]) { | None => i | Some(_) => acc} 
        })
        ({ ...m, slots: m.slots.replaceAt(idx, Some(v))}, idx)
    }

    pure def insert(m: SlotMap[v], k: SlotKey, v: v): SlotMap[v] =
        { ...m, slots: m.slots.replaceAt(k, Some(v)) }

    pure def free(m: SlotMap[v], k: SlotKey): SlotMap[v] = {
        { ...m, slots: m.slots.replaceAt(k, None) }
    }

    pure def free_many(m: SlotMap[v], ks: Set[SlotKey]): SlotMap[v] =
        ks.fold(m, (acc, k) => free(acc, k))

    pure def must_get(m: SlotMap[v], k: SlotKey): v = m.slots[k].unwrap()

    pure def has_data(m: SlotMap[v], k: SlotKey): bool = m.slots[k].is_some()

    pure def find_keys(m: SlotMap[v], pred: v => bool): Set[SlotKey] = {
        m.slots.indices().filter((i) => {
            match (m.slots[i]) {
                | None => false
                | Some(x) => pred(x)
            }
        })
    }

    pure def update(m: SlotMap[v], k: SlotKey, fn: v => v): SlotMap[v] =
         val existing = m.slots[k].unwrap()
         val new_val = fn(existing)
         { ...m, slots: m.slots.replaceAt(k, Some(new_val)) }

    pure def map_some(m: SlotMap[v], pred: (SlotKey, v) => bool, transform: v => v): SlotMap[v] = {
        val new_slots = m.slots.indices().fold(m.slots, (acc, i) => {
            match (m.slots[i]) {
                | None => acc
                | Some(x) => if (pred(i, x)) acc.replaceAt(i, Some(transform(x))) else acc
            }
        })
        {...m, slots: new_slots }
    }
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
        val slots = 1.to(cap).fold(List(), (acc, _) => acc.append(None))
        {
            inbound:  { slots: slots, cap: cap },
            pending:  { data: Set(), in_keys: Set() },
            outbound:  { slots: slots, cap: cap },
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
        val aggregable_data = extract_aggregable_data(pd)
        val non_aggregable_chunks = extract_non_aggregable_chunks(pd)

        val pending_acks = if (non_aggregable_chunks.size() > 0) 1 else 0
        val (inbound, in_key) = slot_map::alloc(p.inbound, {flushed: false, pending: pending_acks, context: pd.context})

        val has_agg = aggregable_data.size() > 0
        val has_non_agg = non_aggregable_chunks.size() > 0
        if (has_agg and has_non_agg) {
            // Both aggregable and not aggregable data
            val (outbound, out_key) = slot_map::alloc(p.outbound, Set(in_key))
            val transition = {
                proc: {
                    ...p,
                    inbound: inbound,
                    pending: {
                        // ISSUE: Type checker doesn't catch stuff like p.pending.union() which doesn't exist
                        data: p.pending.data.union(aggregable_data),
                        in_keys: p.pending.in_keys.union(Set(in_key))
                    }, 
                    outbound: outbound
                },
                // ISSUE: Type checker doesn't catch a missing `Set()` wrapping this
                effects: Set(SendPdata({context: out_key, payload: non_aggregable_chunks}))
            }
            Set(transition)
        } else if (has_agg and not(has_non_agg)) {
            val transition = {
                proc: {
                    ...p,
                    inbound: inbound,
                    pending: {
                        data: p.pending.data.union(aggregable_data),
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
        if (p.pending.data.size() == 0) Set()
        else {
            val (outbound, out_key) = slot_map::alloc(p.outbound, p.pending.in_keys)
            val inbound = slot_map::map_some(
                p.inbound,
                (key, _) => p.pending.in_keys.contains(key),
                tr => { ...tr, flushed: true, pending: tr.pending + 1}
            )
            val out_data = p.pending.data.map(d => Aggregable(d))
            val transition = {
                proc: {
                    ...p,
                    pending: {data: Set(), in_keys: Set()},
                    inbound: inbound,
                    outbound: outbound
                },
                effects: Set(SendPdata({context: out_key, payload: out_data})),
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
            val nack_contexts = nack_keys.map(in_key =>  slot_map::must_get(p.inbound, in_key).context)
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
                val ack_contexts = in_keys.map(in_key => slot_map::must_get(new_proc.inbound, in_key).context)
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
                (acc, key) => if (slot_map::has_data(acc, key)) {
                    slot_map::update(acc, key, tr => {...tr, pending: tr.pending - 1})
                } else acc
            )

            { 
                ...p,
                inbound: new_inbound,
                outbound: slot_map::free(p.outbound, out_key)
            }
        }
    }

    pure def collect_acks(p: Processor): Set[SlotKey] = {
        slot_map::find_keys(p.inbound, tr => and (tr.flushed == true, tr.pending == 0))
    }
}

module acknack3 {
    import common.*
    import slot_map
    import basicSpells.* from "spells/basicSpells"
    import processor.*

    type State = {
        // The processor under test
        proc: Processor,
        // Id of the next context
        next_context: int,
        // Data that's still available to send
        remaining_data: int,
        // What data we've sent and all the associated contexts
        sent: Context -> Set[Data],
        // The data we have sent acks or nacks to the processor for.
        acked: Set[Context],
        // The batches we have sent nacks to the processor for.
        nacked: Set[Context],
        // The data we've received
        received: Set[Pdata],
        // The number of times the processor has acked each batch.
        proc_acked: Set[Context],
        // The number of times the processor has nacked each batch.
        proc_nacked: Set[Context],
    }

    var s: State

    pure def MAX_DATAPOINTS = 6
    pure def MAX_MAP_SIZE = 5 // Tuning this down really does not cut the state space at all
    pure def MAX_DATA_PER_BATCH = 3
    
    action init: bool = all {
        s' = {
            proc: new_processor(MAX_MAP_SIZE),
            next_context:  0,
            remaining_data: MAX_DATAPOINTS,
            sent: Map(),
            acked:       Set(),
            nacked:      Set(),
            received:    Set(),
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

    action bound_state: bool = all {
        // Max datapoints automatically bounds the max number of pdata messages
        s.next_context <= MAX_DATAPOINTS
    }

    pure def apply_transition(s: State, t: Transition): State = {
        val new_s = t.effects.fold(s, (acc, e) =>
            match e {
            | SendPdata(pd)  => { ...acc, received:    acc.received.union(Set(pd))    }
            | NotifyAck(c)  => { ...acc, proc_acked:  acc.proc_acked.union(Set(c))  }
            | NotifyNack(c) => { ...acc, proc_nacked: acc.proc_nacked.union(Set(c)) }
        })
        { ...new_s, proc: t.proc }
    }

    action send_pdata: bool = all {
        bound_state,
        accept_pdata(s.proc),
        {
            nondet num_data = 1.to(min(s.remaining_data, MAX_DATA_PER_BATCH)).oneOf()
            nondet num_agg_data = 1.to(num_data).oneOf()
            val num_non_agg_data = num_data - num_agg_data
            val offset = s.remaining_data - num_data 
            val agg_data = 1.to(num_agg_data).map(x => x + offset)
            val non_agg_data = 1.to(num_non_agg_data).map(x => x + offset + num_agg_data )
            val agg_chunks = agg_data.map(d => Aggregable(d))
            val non_agg_chunks = non_agg_data.map(d => NotAggregable(d))

            val payload = agg_chunks.union(non_agg_chunks)
            val sent_data = agg_data.union(non_agg_data)

            val transitions = process(s.proc, PdataMessage({context: s.next_context, payload: payload}))
            nondet transition = transitions.oneOf()
            val new_s = apply_transition(s, transition)

            s' = {
                ...new_s,
                remaining_data: s.remaining_data - num_data,
                sent: s.sent.put(s.next_context, sent_data),
                next_context: new_s.next_context + 1,
            }
        }
    }

    action ack_step(): bool = {
        // Consider excluding stuff we've already acked
        nondet pd = s.received.oneOf()
        send_ack(pd.context)
    }

    action nack_step(): bool = {
        // Consider excluding stuff we've already nacked
        nondet pd = s.received.oneOf()
        send_nack(pd.context)
    }

    action send_ack(c: Context): bool = {
        val transitions = process(s.proc, AckMessage(c))
        nondet transition = transitions.oneOf()
        val new_s = apply_transition(s, transition) 
        all {
            s' = { ...new_s, acked: s.acked.union(Set(c))}
        }
    }

    action send_nack(c: Context): bool = {
        val transitions = process(s.proc, NackMessage(c))
        nondet transition = transitions.oneOf()
        val new_s = apply_transition(s, transition)
        all {
            s' = { ...new_s, nacked: s.nacked.union(Set(c))}
        }
    }

    action send_timer_tick: bool = {
        val transitions = process(s.proc, TimerTickMessage)
        nondet transition = transitions.oneOf()
        all {
            s.proc.pending.data.size() > 0,
            s' = apply_transition(s, transition)
        }
    }

    def acked_data: Set[Data] = {
      s.received.filter(pd => s.acked.contains(pd.context)).map(extract_data).flatten()
    }
}
