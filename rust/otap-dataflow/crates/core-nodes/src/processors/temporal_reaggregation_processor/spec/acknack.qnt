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
        { ...m, map: s.foldl(m.map, (acc, key) => mapRemove(acc, key))}
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

    var outbox: List[Effect]
    var proc: Processor

    val state = {
        processor: proc,
        outbox: outbox
    }

    pure def new(cap: int): Processor = {
        {
            inbound: slot_map::new(cap),
            pending: Set(),
            outbound: slot_map::new(cap),
            outbound_batch: 0
        }
    }

    def accept_pdata(): bool = {
        slot_map::has_cap(proc.inbound) and slot_map::remaining_cap(proc.outbound) >= 2
    }

    action init = {
        // nondet cap = oneOf(2.to(8))
        pure val cap = 8

        all {
            proc' = new(cap),
            outbox' = List(),
        }
    }

    action process_message(m: Message): bool = {
        match m {
            | Pdata(b) => process_pdata(b)
            | Ack(b) => process_ack(b)
            | Nack(b) => process_nack(b)
            | TimerTick => flush
        }
    }

    action process_pdata(b: Batch): bool = {
        any {
            process_pdata_partial(b),
            process_pdata_full(b)
        }
    }

    action process_pdata_full(b: Batch): bool = {
        all {
            proc' = {
                ...proc,
                inbound: slot_map::insert(proc.inbound, b, { flushed: false, pending: 1 }), 
                pending: proc.pending.union(Set(b)),
            },
            outbox' = outbox,
        }
    }

    action process_pdata_partial(b: Batch): bool = {
        all {
           proc' = {
                ...proc,  
                // Track the inbound
                inbound: slot_map::insert(proc.inbound, b, { flushed: false, pending: 1 }), 
                pending: proc.pending.union(Set(b)),

                // Also track the passthrough
                outbound: slot_map::insert(proc.outbound, proc.outbound_batch, Set(b)), 
                outbound_batch: proc.outbound_batch + 1
           },
           outbox' = outbox.append(SendPdata(proc.outbound_batch))
        }
    }

    action flush: bool = {
        all {
            proc' = {
                ...proc,
                pending: Set(),
                outbound: slot_map::insert(proc.outbound, proc.outbound_batch, proc.pending),
            },
            outbox' = outbox.append(SendPdata(proc.outbound_batch))
        }
    }

    action process_ack(b: Batch): bool = {
        val p = apply_ack(proc, b)
        val acks = collect_acks(p)
        val inbound = slot_map::remove_many(p.inbound, acks)
        all {
            proc' = { ...p, inbound: inbound },
            outbox' = outbox.concat(acks.foldl(List(), (acc, b) => acc.append(NotifyAck(b))))
        }
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


    action process_nack(b: Batch): bool = {
        all {
            proc' = {
                ...proc
            },
            outbox' = outbox
        }
    }

}

module acknack {
    import common.*
    import processor
    import slot_map
    import basicSpells.* from "spells/basicSpells"

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
    }

    var s: AckNackState
    import processor as proc

    action init: bool = all {
        proc::init,
        s' = {
            next_pdata:  0,
            received:    Set(),
            acked:       Set(),
            nacked:      Set(),
            proc_acked:  Map(),
            proc_nacked: Map(),
        }
    }

    val state = {
        s: s,
        proc: proc::state,
    }

    action step: bool = {
        nondet ack_nack_batch = s.received.oneOf() 

        any {
            drain_outbox,
            send_pdata,
            send_timer_tick,
            send_ack(ack_nack_batch),
            send_nack(ack_nack_batch)
        }
    }

    action send_pdata: bool = all {
        s.next_pdata < 64,
        proc::process_message(Pdata(s.next_pdata)),
        s' = { ...s, next_pdata: s.next_pdata + 1 },
    }

    action send_ack(batch: Batch): bool = all {
       proc::process_message(Ack(batch)),
       s' = { ...s, acked: s.acked.union(Set(batch)) }
    }

    action send_nack(batch: Batch): bool = all {
       proc::process_message(Nack(batch)),
       s' = { ...s, nacked: s.nacked.union(Set(batch)) }
    }

    action send_timer_tick: bool = all {
        proc::process_message(TimerTick),
        s' = s,
    }

    action drain_outbox: bool = all {
        proc::proc' = proc::proc,
        proc::outbox' = List(),
        s' = {
            ...s,
            received: proc::outbox.foldl(s.received, (acc, e) =>
                match e {
                | SendPdata(p) => acc.union(Set(p))
                | _ => acc
                }),
            proc_acked: proc::outbox.foldl(s.proc_acked, (acc, e) =>
                match e {
                | NotifyAck(p) => acc.setByWithDefault(p, v => v + 1, 1)
                | _ => acc
                }),
            proc_nacked: proc::outbox.foldl(s.proc_nacked, (acc, e) =>
                match e {
                | NotifyNack(p) => acc.setByWithDefault(p, v => v + 1, 1)
                | _ => acc
                }),
        }
    }
}
