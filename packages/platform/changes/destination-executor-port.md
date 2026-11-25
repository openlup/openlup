### Experimental native destination port

Native hosts can use `createPostgresDestinationPortV2` on the destinations
server subpath with their own executor. It supports retained reads, exact replay,
rechecks and order binding while preserving the native owner's decisions.
Fresh issuance remains disabled in the host and starter.
