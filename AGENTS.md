# Project guidance

Before replacing a transport or making another major architecture change, explain
whether the proposed change fits this project and recommend keeping or changing it.
Do not silently implement a requested swap when another option is a better fit.

Hosted play uses WebSockets for session creation, room admission, gameplay, and
server-pushed updates. HTTP serves browser assets/configuration and deployment
health only. Do not reintroduce REST admission, HTTP probes, or gameplay polling.
Preserve the model/service separation, Host authorization, recipient-specific hand
privacy, bounded transport resources, and meaningful behavioral tests.

Keep data-only command contexts and membership as plain records. Public snapshot
mapping belongs in host/. Prefer removing duplicate plumbing over adding wrapper layers.
