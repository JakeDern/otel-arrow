------------------------------- MODULE acknack3 -------------------------------

EXTENDS Integers, Sequences, FiniteSets, TLC, Apalache, Variants

(*
  @type: (((a -> b), a) => Bool);
*)
has(m_1461, key_1461) == key_1461 \in DOMAIN m_1461

VARIABLE
  (*
    @type: { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) };
  *)
  s

(*
  @type: ((Int) => { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) });
*)
new_processor(cap_431) ==
  [inbound |-> [map |-> SetAsFun({}), free |-> 0 .. cap_431 - 1],
    pending |-> {},
    outbound |-> [map |-> SetAsFun({}), free |-> 0 .. cap_431 - 1]]

(*
  @type: (({ free: Set(Int), map: (Int -> g) }, g) => <<{ free: Set(Int), map: (Int -> g) }, Int>>);
*)
slot_map_alloc(slot_map_m_150, slot_map_v_150) ==
  LET (*
    @type: (() => Int);
  *)
  slot_map_k ==
    LET (*
      @type: ((Int, Int) => Int);
    *)
    __QUINT_LAMBDA6(slot_map_acc_129, slot_map_x_129) ==
      IF slot_map_acc_129 = -1 THEN slot_map_x_129 ELSE slot_map_acc_129
    IN
    ApaFoldSet(__QUINT_LAMBDA6, (-1), slot_map_m_150["free"])
  IN
  <<
    [map |->
        LET (*
          @type: (() => (Int -> g));
        *)
        __quint_var5 == slot_map_m_150["map"]
        IN
        LET (*@type: (() => Set(Int)); *) __quint_var6 == DOMAIN __quint_var5 IN
        [
          __quint_var7 \in {(slot_map_k)} \union __quint_var6 |->
            IF __quint_var7 = slot_map_k
            THEN slot_map_v_150
            ELSE (__quint_var5)[__quint_var7]
        ],
      free |-> slot_map_m_150["free"] \ {(slot_map_k)}], (slot_map_k)
  >>

(*
  @type: ((Int) => NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int));
*)
SendPdata(__SendPdataParam_40) == Variant("SendPdata", __SendPdataParam_40)

(*
  @type: (({ free: Set(Int), map: (Int -> h) }, Int) => Bool);
*)
slot_map_has_data(slot_map_m_267, slot_map_k_267) ==
  slot_map_k_267 \in DOMAIN (slot_map_m_267["map"])

(*
  @type: (({ free: Set(Int), map: (Int -> j) }, Int) => j);
*)
slot_map_must_get(slot_map_m_252, slot_map_k_252) ==
  slot_map_m_252["map"][slot_map_k_252]

(*
  @type: (({ free: Set(Int), map: (Int -> k) }, Int, ((k) => k)) => { free: Set(Int), map: (Int -> k) });
*)
slot_map_update(slot_map_m_329, slot_map_k_329, slot_map_fn_329(_)) ==
  IF slot_map_k_329 \in DOMAIN (slot_map_m_329["map"])
  THEN [
    slot_map_m_329 EXCEPT
      !["map"] =
        LET (*
          @type: (() => (Int -> k));
        *)
        __quint_var8 == slot_map_m_329["map"]
        IN
        LET (*@type: (() => Set(Int)); *) __quint_var9 == DOMAIN __quint_var8 IN
        [
          __quint_var10 \in {slot_map_k_329} \union __quint_var9 |->
            IF __quint_var10 = slot_map_k_329
            THEN slot_map_fn_329(slot_map_m_329["map"][slot_map_k_329])
            ELSE (__quint_var8)[__quint_var10]
        ]
  ]
  ELSE slot_map_m_329

(*
  @type: (({ free: Set(Int), map: (Int -> l) }, Int) => { free: Set(Int), map: (Int -> l) });
*)
slot_map_free(slot_map_m_217, slot_map_k_217) ==
  LET (*
    @type: (() => (Int -> l));
  *)
  slot_map_newMap ==
    LET (*
      @type: (((Int -> l), Int) => (Int -> l));
    *)
    __QUINT_LAMBDA7(slot_map_acc_203, slot_map_key_203) ==
      IF slot_map_key_203 = slot_map_k_217
      THEN slot_map_acc_203
      ELSE LET (*
        @type: (() => (Int -> l));
      *)
      __quint_var11 == slot_map_acc_203
      IN
      LET (*@type: (() => Set(Int)); *) __quint_var12 == DOMAIN __quint_var11 IN
      [
        __quint_var13 \in {slot_map_key_203} \union __quint_var12 |->
          IF __quint_var13 = slot_map_key_203
          THEN slot_map_m_217["map"][slot_map_key_203]
          ELSE (__quint_var11)[__quint_var13]
      ]
    IN
    ApaFoldSet(__QUINT_LAMBDA7, (SetAsFun({})), DOMAIN (slot_map_m_217["map"]))
  IN
  [map |-> slot_map_newMap,
    free |-> slot_map_m_217["free"] \union {slot_map_k_217}]

(*
  @type: (({ free: Set(Int), map: (Int -> p) }, ((p) => Bool)) => Set(Int));
*)
slot_map_find_keys(slot_map_m_292, slot_map_pred_292(_)) ==
  {
    slot_map_k_290 \in DOMAIN (slot_map_m_292["map"]):
      slot_map_pred_292(slot_map_m_292["map"][slot_map_k_290])
  }

(*
  @type: ((Int) => NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int));
*)
NotifyAck(__NotifyAckParam_46) == Variant("NotifyAck", __NotifyAckParam_46)

(*
  @type: ((Int) => NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int));
*)
NotifyNack(__NotifyNackParam_52) == Variant("NotifyNack", __NotifyNackParam_52)

(*
  @type: (({ free: Set(Int), map: (Int -> t) }, ((Int, t) => Bool), ((t) => t)) => { free: Set(Int), map: (Int -> t) });
*)
slot_map_map_some(slot_map_m_378, slot_map_pred_378(_, _), slot_map_transform_378(_)) ==
  LET (*
    @type: (({ free: Set(Int), map: (Int -> t) }, Int) => { free: Set(Int), map: (Int -> t) });
  *)
  __QUINT_LAMBDA14(slot_map_acc_376, slot_map_k_376) ==
    LET (*
      @type: (() => t);
    *)
    slot_map_v == slot_map_acc_376["map"][slot_map_k_376]
    IN
    IF slot_map_pred_378(slot_map_k_376, (slot_map_v))
    THEN [
      slot_map_acc_376 EXCEPT
        !["map"] =
          LET (*
            @type: (() => (Int -> t));
          *)
          __quint_var14 == slot_map_acc_376["map"]
          IN
          LET (*
            @type: (() => Set(Int));
          *)
          __quint_var15 == DOMAIN __quint_var14
          IN
          [
            __quint_var16 \in {slot_map_k_376} \union __quint_var15 |->
              IF __quint_var16 = slot_map_k_376
              THEN slot_map_transform_378((slot_map_v))
              ELSE (__quint_var14)[__quint_var16]
          ]
    ]
    ELSE slot_map_acc_376
  IN
  ApaFoldSet(__QUINT_LAMBDA14, slot_map_m_378, DOMAIN (slot_map_m_378["map"]))

(*
  @type: (() => Ack(Int) | Nack(Int) | Pdata(Int) | TimerTick({ tag: Str }));
*)
TimerTick == Variant("TimerTick", [tag |-> "UNIT"])

(*
  @type: ((Int) => Ack(Int) | Nack(Int) | Pdata(Int) | TimerTick({ tag: Str }));
*)
Pdata(__PdataParam_13) == Variant("Pdata", __PdataParam_13)

(*
  @type: (({ free: Set(Int), map: (Int -> m) }) => Bool);
*)
slot_map_has_cap(slot_map_m_102) == Cardinality(slot_map_m_102["free"]) > 0

(*
  @type: (({ free: Set(Int), map: (Int -> v) }) => Int);
*)
slot_map_remaining_cap(slot_map_m_89) == Cardinality(slot_map_m_89["free"])

(*
  @type: ((Int) => Ack(Int) | Nack(Int) | Pdata(Int) | TimerTick({ tag: Str }));
*)
Ack(__AckParam_19) == Variant("Ack", __AckParam_19)

(*
  @type: ((Int) => Ack(Int) | Nack(Int) | Pdata(Int) | TimerTick({ tag: Str }));
*)
Nack(__NackParam_25) == Variant("Nack", __NackParam_25)

(*
  @type: (((c -> d), c, ((d) => d), d) => (c -> d));
*)
setByWithDefault(m_2256, k_2256, op_2256(_), default_2256) ==
  IF has(m_2256, k_2256)
  THEN LET (*@type: (() => (c -> d)); *) __quint_var0 == m_2256 IN
  [ (__quint_var0) EXCEPT ![k_2256] = op_2256((__quint_var0)[k_2256]) ]
  ELSE LET (*
    @type: (() => (c -> d));
  *)
  __quint_var4 ==
    LET (*@type: (() => (c -> d)); *) __quint_var1 == m_2256 IN
    LET (*@type: (() => Set(c)); *) __quint_var2 == DOMAIN __quint_var1 IN
    [
      __quint_var3 \in {k_2256} \union __quint_var2 |->
        IF __quint_var3 = k_2256
        THEN default_2256
        ELSE (__quint_var1)[__quint_var3]
    ]
  IN
  [ (__quint_var4) EXCEPT ![k_2256] = op_2256((__quint_var4)[k_2256]) ]

(*
  @type: (() => Bool);
*)
init ==
  s
      = [proc |-> new_processor(4),
        next_pdata |-> 0,
        received |-> {},
        acked |-> {},
        nacked |-> {},
        proc_acked |-> SetAsFun({}),
        proc_nacked |-> SetAsFun({})]

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, Int) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
*)
process_pdata_partial(p_699, b_699) ==
  LET (*
    @type: (() => <<{ free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, Int>>);
  *)
  quintDestructTemp644 ==
    slot_map_alloc(p_699["inbound"], [flushed |-> FALSE, pending |-> 1])
  IN
  LET (*@type: (() => Int); *) in_key == (quintDestructTemp644)[2] IN
  LET (*
    @type: (() => { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) });
  *)
  inbound == (quintDestructTemp644)[1]
  IN
  LET (*
    @type: (() => <<{ free: Set(Int), map: (Int -> Set(Int)) }, Int>>);
  *)
  quintDestructTemp651 == slot_map_alloc(p_699["outbound"], {(in_key)})
  IN
  LET (*@type: (() => Int); *) out_key == (quintDestructTemp651)[2] IN
  LET (*
    @type: (() => { free: Set(Int), map: (Int -> Set(Int)) });
  *)
  outbound == (quintDestructTemp651)[1]
  IN
  LET (*
    @type: (() => { effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } });
  *)
  transition ==
    [proc |->
        [
          [
            [ p_699 EXCEPT !["inbound"] = inbound ] EXCEPT
              !["pending"] = p_699["pending"] \union {(in_key)}
          ] EXCEPT
            !["outbound"] = outbound
        ],
      effects |-> {(SendPdata((out_key)))}]
  IN
  {(transition)}

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, Int) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
*)
process_pdata_full(p_627, b_627) ==
  LET (*
    @type: (() => <<{ free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, Int>>);
  *)
  quintDestructTemp595 ==
    slot_map_alloc(p_627["inbound"], [flushed |-> FALSE, pending |-> 0])
  IN
  LET (*@type: (() => Int); *) key == (quintDestructTemp595)[2] IN
  LET (*
    @type: (() => { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) });
  *)
  inbound == (quintDestructTemp595)[1]
  IN
  LET (*
    @type: (() => { effects: Set(i), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } });
  *)
  transition ==
    [proc |->
        [
          [ p_627 EXCEPT !["inbound"] = inbound ] EXCEPT
            !["pending"] = p_627["pending"] \union {(key)}
        ],
      effects |-> {}]
  IN
  {(transition)}

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, Int) => { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) });
*)
apply_ack(p_870, b_870) ==
  IF ~(slot_map_has_data(p_870["outbound"], b_870))
  THEN p_870
  ELSE LET (*
    @type: (() => Set(Int));
  *)
  inbounds == slot_map_must_get(p_870["outbound"], b_870)
  IN
  LET (*
    @type: (() => { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) });
  *)
  new_inbound ==
    LET (*
      @type: (({ free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, Int) => { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) });
    *)
    __QUINT_LAMBDA9(acc_853, key_853) ==
      LET (*
        @type: (({ flushed: Bool, pending: Int }) => { flushed: Bool, pending: Int });
      *)
      __QUINT_LAMBDA8(tr_851) ==
        [ tr_851 EXCEPT !["pending"] = tr_851["pending"] - 1 ]
      IN
      slot_map_update(acc_853, key_853, __QUINT_LAMBDA8)
    IN
    ApaFoldSet(__QUINT_LAMBDA9, p_870["inbound"], (inbounds))
  IN
  [
    [ p_870 EXCEPT !["inbound"] = new_inbound ] EXCEPT
      !["outbound"] = slot_map_free(p_870["outbound"], b_870)
  ]

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }) => Set(Int));
*)
collect_acks(p_893) ==
  LET (*
    @type: (({ flushed: Bool, pending: Int }) => Bool);
  *)
  __QUINT_LAMBDA10(tr_891) == tr_891["flushed"] = TRUE /\ tr_891["pending"] = 0
  IN
  slot_map_find_keys(p_893["inbound"], __QUINT_LAMBDA10)

(*
  @type: (({ free: Set(Int), map: (Int -> r) }, Set(Int)) => { free: Set(Int), map: (Int -> m) });
*)
slot_map_free_many(slot_map_m_238, slot_map_ks_238) ==
  LET (*
    @type: (({ free: Set(Int), map: (Int -> r) }, Int) => { free: Set(Int), map: (Int -> m) });
  *)
  __QUINT_LAMBDA11(slot_map_acc_236, slot_map_k_236) ==
    slot_map_free(slot_map_acc_236, slot_map_k_236)
  IN
  ApaFoldSet(__QUINT_LAMBDA11, slot_map_m_238, slot_map_ks_238)

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
*)
flush(p_563) ==
  IF Cardinality(p_563["pending"]) = 0
  THEN {[proc |-> p_563, effects |-> {}]}
  ELSE LET (*
    @type: (() => <<{ free: Set(Int), map: (Int -> Set(Int)) }, Int>>);
  *)
  quintDestructTemp505 == slot_map_alloc(p_563["outbound"], p_563["pending"])
  IN
  LET (*@type: (() => Int); *) key == (quintDestructTemp505)[2] IN
  LET (*
    @type: (() => { free: Set(Int), map: (Int -> Set(Int)) });
  *)
  outbound == (quintDestructTemp505)[1]
  IN
  LET (*
    @type: (() => { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) });
  *)
  inbound ==
    LET (*
      @type: ((Int, { flushed: Bool, pending: Int }) => Bool);
    *)
    __QUINT_LAMBDA15(id_516, id__516) == id_516 \in p_563["pending"]
    IN
    LET (*
      @type: (({ flushed: Bool, pending: Int }) => { flushed: Bool, pending: Int });
    *)
    __QUINT_LAMBDA16(tr_527) ==
      [flushed |-> TRUE, pending |-> tr_527["pending"] + 1]
    IN
    slot_map_map_some(p_563["inbound"], __QUINT_LAMBDA15, __QUINT_LAMBDA16)
  IN
  LET (*
    @type: (() => { effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } });
  *)
  transition ==
    [proc |->
        [
          [ [ p_563 EXCEPT !["pending"] = {} ] EXCEPT !["inbound"] = inbound ] EXCEPT
            !["outbound"] = outbound
        ],
      effects |-> {(SendPdata((key)))}]
  IN
  {(transition)}

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }) => Bool);
*)
accept_pdata(p_447) ==
  slot_map_has_cap(p_447["inbound"])
    /\ slot_map_remaining_cap(p_447["outbound"]) >= 2

(*
  @type: (({ acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) }, { effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }) => { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) });
*)
apply_transition(s_1015, t_1015) ==
  LET (*
    @type: (() => { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) });
  *)
  new_s ==
    LET (*
      @type: (({ acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) }, NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)) => { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) });
    *)
    __QUINT_LAMBDA5(acc_1005, e_1005) ==
      CASE VariantTag(e_1005) = "SendPdata"
          -> LET (*
            @type: ((Int) => { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) });
          *)
          __QUINT_LAMBDA0(b_997) ==
            [
              acc_1005 EXCEPT
                !["received"] = acc_1005["received"] \union {b_997}
            ]
          IN
          __QUINT_LAMBDA0(VariantGetUnsafe("SendPdata", e_1005))
        [] VariantTag(e_1005) = "NotifyAck"
          -> LET (*
            @type: ((Int) => { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) });
          *)
          __QUINT_LAMBDA2(b_1000) ==
            [
              acc_1005 EXCEPT
                !["proc_acked"] =
                  LET (*
                    @type: ((Int) => Int);
                  *)
                  __QUINT_LAMBDA1(v_976) == v_976 + 1
                  IN
                  setByWithDefault(acc_1005["proc_acked"], b_1000, __QUINT_LAMBDA1,
                  0)
            ]
          IN
          __QUINT_LAMBDA2(VariantGetUnsafe("NotifyAck", e_1005))
        [] VariantTag(e_1005) = "NotifyNack"
          -> LET (*
            @type: ((Int) => { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) });
          *)
          __QUINT_LAMBDA4(b_1003) ==
            [
              acc_1005 EXCEPT
                !["proc_nacked"] =
                  LET (*
                    @type: ((Int) => Int);
                  *)
                  __QUINT_LAMBDA3(v_990) == v_990 + 1
                  IN
                  setByWithDefault(acc_1005["proc_nacked"], b_1003, __QUINT_LAMBDA3,
                  0)
            ]
          IN
          __QUINT_LAMBDA4(VariantGetUnsafe("NotifyNack", e_1005))
    IN
    ApaFoldSet(__QUINT_LAMBDA5, s_1015, t_1015["effects"])
  IN
  [ (new_s) EXCEPT !["proc"] = t_1015["proc"] ]

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, Int) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
*)
process_pdata(p_578, b_578) ==
  process_pdata_partial(p_578, b_578) \union process_pdata_full(p_578, b_578)

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, Int) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
*)
process_ack(p_814, b_814) ==
  IF ~(slot_map_has_data(p_814["outbound"], b_814))
  THEN {}
  ELSE LET (*
    @type: (() => { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) });
  *)
  new_proc == apply_ack(p_814, b_814)
  IN
  LET (*@type: (() => Set(Int)); *) acks == collect_acks((new_proc)) IN
  LET (*
    @type: (() => { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) });
  *)
  inbound == slot_map_free_many((new_proc)["inbound"], (acks))
  IN
  {[proc |-> [ (new_proc) EXCEPT !["inbound"] = inbound ],
    effects |->
      LET (*
        @type: ((Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), Int) => Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)));
      *)
      __QUINT_LAMBDA12(acc_805, b_805) == acc_805 \union {(NotifyAck(b_805))}
      IN
      ApaFoldSet(__QUINT_LAMBDA12, {}, (acks))]}

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, Int) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
*)
process_nack(p_763, b_763) ==
  IF ~(slot_map_has_data(p_763["outbound"], b_763))
  THEN {}
  ELSE LET (*
    @type: (() => Set(Int));
  *)
  inbounds == slot_map_must_get(p_763["outbound"], b_763)
  IN
  LET (*
    @type: (() => Set(Int));
  *)
  nacks == { i_727 \in inbounds: slot_map_has_data(p_763["inbound"], i_727) }
  IN
  {[proc |->
      [
        [
          p_763 EXCEPT
            !["inbound"] = slot_map_free_many(p_763["inbound"], (nacks))
        ] EXCEPT
          !["outbound"] = slot_map_free(p_763["outbound"], b_763)
      ],
    effects |->
      LET (*
        @type: ((Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), Int) => Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)));
      *)
      __QUINT_LAMBDA13(acc_755, b_755) == acc_755 \union {(NotifyNack(b_755))}
      IN
      ApaFoldSet(__QUINT_LAMBDA13, {}, (nacks))]}

(*
  @type: (() => Bool);
*)
q_init == init

(*
  @type: (({ inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, Ack(Int) | Nack(Int) | Pdata(Int) | TimerTick({ tag: Str })) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
*)
process(p_480, m_480) ==
  CASE VariantTag(m_480) = "Pdata"
      -> LET (*
        @type: ((Int) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
      *)
      __QUINT_LAMBDA17(b_469) == process_pdata(p_480, b_469)
      IN
      __QUINT_LAMBDA17(VariantGetUnsafe("Pdata", m_480))
    [] VariantTag(m_480) = "Ack"
      -> LET (*
        @type: ((Int) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
      *)
      __QUINT_LAMBDA18(b_472) == process_ack(p_480, b_472)
      IN
      __QUINT_LAMBDA18(VariantGetUnsafe("Ack", m_480))
    [] VariantTag(m_480) = "Nack"
      -> LET (*
        @type: ((Int) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
      *)
      __QUINT_LAMBDA19(b_475) == process_nack(p_480, b_475)
      IN
      __QUINT_LAMBDA19(VariantGetUnsafe("Nack", m_480))
    [] VariantTag(m_480) = "TimerTick"
      -> LET (*
        @type: (({ tag: Str }) => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
      *)
      __QUINT_LAMBDA20(id__478) == flush(p_480)
      IN
      __QUINT_LAMBDA20(VariantGetUnsafe("TimerTick", m_480))

(*
  @type: (() => Bool);
*)
send_timer_tick ==
  LET (*
    @type: (() => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
  *)
  transitions == process(s["proc"], (TimerTick))
  IN
  \E transition \in transitions:
    Cardinality(s["proc"]["pending"]) > 0
      /\ s' := (apply_transition(s, transition))

(*
  @type: (() => Bool);
*)
send_pdata ==
  LET (*
    @type: (() => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
  *)
  transitions == process(s["proc"], (Pdata(s["next_pdata"])))
  IN
  \E transition \in transitions:
    LET (*
      @type: (() => { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) });
    *)
    new_s == apply_transition(s, transition)
    IN
    s["next_pdata"] < 2
      /\ accept_pdata(s["proc"])
      /\ s' := [ (new_s) EXCEPT !["next_pdata"] = (new_s)["next_pdata"] + 1 ]

(*
  @type: ((Int) => Bool);
*)
send_ack(b_1118) ==
  LET (*
    @type: (() => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
  *)
  transitions == process(s["proc"], (Ack(b_1118)))
  IN
  \E transition \in transitions:
    LET (*
      @type: (() => { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) });
    *)
    new_s == apply_transition(s, transition)
    IN
    s' := [ (new_s) EXCEPT !["acked"] = s["acked"] \union {b_1118} ]

(*
  @type: ((Int) => Bool);
*)
send_nack(b_1152) ==
  LET (*
    @type: (() => Set({ effects: Set(NotifyAck(Int) | NotifyNack(Int) | SendPdata(Int)), proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) } }));
  *)
  transitions == process(s["proc"], (Nack(b_1152)))
  IN
  \E transition \in transitions:
    LET (*
      @type: (() => { acked: Set(Int), nacked: Set(Int), next_pdata: Int, proc: { inbound: { free: Set(Int), map: (Int -> { flushed: Bool, pending: Int }) }, outbound: { free: Set(Int), map: (Int -> Set(Int)) }, pending: Set(Int) }, proc_acked: (Int -> Int), proc_nacked: (Int -> Int), received: Set(Int) });
    *)
    new_s == apply_transition(s, transition)
    IN
    s' := [ (new_s) EXCEPT !["nacked"] = s["nacked"] \union {b_1152} ]

(*
  @type: (() => Bool);
*)
ack_step == \E batch \in s["received"] \ s["acked"]: send_ack(batch)

(*
  @type: (() => Bool);
*)
nack_step == \E batch \in s["received"] \ s["nacked"]: send_nack(batch)

(*
  @type: (() => Bool);
*)
step == send_pdata\/ send_timer_tick\/ ack_step\/ nack_step

(*
  @type: (() => Bool);
*)
q_step == step

================================================================================
