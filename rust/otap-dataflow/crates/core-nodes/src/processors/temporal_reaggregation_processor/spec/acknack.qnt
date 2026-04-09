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
        nondet cap = oneOf(2.to(16))

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
            | TimerTick => process_timer
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
                inbound: slot_map::insert(proc.inbound, b, { flushed: false, pending: 1 }), 
                pending: proc.pending.union(Set(b)),
                outbound: slot_map::insert(proc.outbound, proc.outbound_batch, Set(b)), 
                outbound_batch: proc.outbound_batch + 1
           },
           outbox' = outbox.append(SendPdata(proc.outbound_batch))
        }
    }

    action process_ack(b: Batch): bool = {
        all {
            proc' = {
                ...proc
            },
            outbox' = outbox
        }
    }

    action process_nack(b: Batch): bool = {
        all {
            proc' = {
                ...proc
            },
            outbox' = outbox
        }
    }

    action process_timer: bool = {
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

    // The id of the next pdata
    var next_pdata: Batch

    // The batches we have sent acks or nacks to the processor for
    var acked: Set[Batch]
    var nacked: Set[Batch]

    // The batches the processor has sent out
    var received: Set[Batch]
    // The batches the processor has acked or nacked
    var proc_acked: Batch -> int
    var proc_nacked: Batch -> int

    var outbox: List[Effect]
    import processor as proc

    val state = { 
        received: received,
        acked: acked,
        nacked: nacked,
        proc_acked: proc_acked,
        proc_nacked: proc_nacked,
    }

    action init: bool = {
        all {
            proc::init,
            next_pdata'  = 0,
            received'    = Set(),
            acked'       = Set(),
            nacked'      = Set(),
            proc_acked'  = Map(),
            proc_nacked' = Map(),
        }
    }

    action step: bool = {
        any {
            drain_outbox,
            send_pdata,
        }
    }

    action send_pdata: bool = {
       all {
            next_pdata < 1024,
            next_pdata' = next_pdata + 1,
            proc::process_message(Pdata(next_pdata)),

            proc_acked' = proc_acked,
            proc_nacked' = proc_nacked,
            acked' = acked,
            nacked' = nacked,
            received' = received,
       } 
    }

    action drain_outbox: bool = {
        all {
            proc::outbox' = proc::outbox,
            proc::proc' = proc::proc,
            received' = proc::outbox.foldl(received, (acc, e) => {
                match e {
                    | SendPdata(p) => acc.union(Set(p))
                    | _ => acc
                }
            }),
            proc_acked' = proc::outbox.foldl(proc_acked, (acc, e) => {
                match e {
                    | NotifyAck(p) => acc.setByWithDefault(p, v => v + 1, 1)
                    | _ => acc
                }
            }),
            proc_nacked' = proc::outbox.foldl(proc_nacked, (acc, e) => {
                match e {
                    | NotifyNack(p) => acc.setByWithDefault(p, v => v + 1, 1)
                    | _ => acc
                }
            }),
            acked' = acked,
            nacked' = nacked,
            next_pdata' = next_pdata
        }
    }
}
