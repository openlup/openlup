export const OMNIPACK_SIMULATOR_RESOURCE_NAMES = [
  "POST /orders",
  "GET /stock",
  "GET /stock-movements",
  "GET /fulfilments",
  "GET /fulfilment-requests",
  "webhooks",
] as const;

export const OMNIPACK_SIMULATOR_FIXTURES = {
  outboundOrderRequest: {
    orderNumber: "openlup-order-1001",
    items: [
      {
        sku: "OPENLUP-KARMA-ADULT-2KG",
        quantity: 2,
      },
    ],
    shippingDetails: {
      carrier: "INPOST",
      service: "PACZKOMAT",
      pickUpPoint: {
        name: "WAW01A",
        address: "ul. Testowa 1, 00-001 Warszawa",
      },
      firstName: "Test",
      lastName: "Customer",
      email: "customer@example.test",
      phone: "+48000000000",
      street: "Testowa",
      streetNumber: "1",
      city: "Warszawa",
      postalCode: "00-001",
      countryCode: "PL",
    },
  },
  placeOrderResponse: {
    orderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
  },
  stockResponse: {
    _embedded: {
      stockItems: [
        {
          sku: "OPENLUP-KARMA-ADULT-2KG",
          productName: "openlup Adult 2kg",
          totalQuantity: 48,
          forSaleQuantity: 35,
          expireSoonQuantity: 2,
          faultyQuantity: 0,
          complaintsQuantity: 0,
          withheldQuantity: 3,
          packagingQuantity: 1,
          processingQuantity: 7,
          unpackingQuantity: 0,
        },
      ],
    },
  },
  stockMovementsResponse: {
    _embedded: [
      {
        occurredAt: "2026-06-10T08:30:00+00:00",
        sku: "OPENLUP-KARMA-ADULT-2KG",
        productName: "openlup Adult 2kg",
        fulfilmentCenter: "OMNIPACK-WAW",
        quantity: -2,
        operationType: "order_shipped",
        warehouseDocumentNumber: "WZ/2026/1001",
        number: "MOV-1001",
        logicalWarehouse: "MAIN",
        productLotNumber: "LOT-2026-06",
        expirationDate: "2027-06-30",
        eans: ["5900000000001"],
      },
    ],
  },
  fulfilmentsResponse: {
    _embedded: {
      fulfilments: [
        {
          orderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
          fulfilmentNumber: "FUL-1001",
          externalNumber: "openlup-order-1001",
          orderNumber: "openlup-order-1001",
          createdAt: "2026-06-10T08:00:00+00:00",
          updatedAt: "2026-06-10T09:00:00+00:00",
          status: "shipped",
          subStatus: "handed_over_to_carrier",
          orderValue: {
            amount: 12990,
            currency: "PLN",
          },
          trackingNumbers: ["INPOST-TRACK-1001"],
          shipments: [
            {
              trackingNo: "INPOST-TRACK-1001",
              shippingMethod: "INPOST_PACZKOMAT",
              trackingUrl: "https://inpost.example/track/INPOST-TRACK-1001",
            },
          ],
          items: [
            {
              sku: "OPENLUP-KARMA-ADULT-2KG",
              quantity: 2,
              productLotNumber: "LOT-2026-06",
              expirationDate: "2027-06-30",
            },
          ],
        },
      ],
    },
  },
  fulfilmentRequestsResponse: {
    _embedded: {
      fulfilmentRequests: [
        {
          warehouseDocumentNumber: "PZ/2026/5001",
          warehouseName: "OMNIPACK-WAW",
          state: "accepted",
        },
      ],
    },
  },
  webhooks: {
    shipmentAccepted: {
      event: "shipment.accepted",
      orderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
      orderNumber: "openlup-order-1001",
      fulfilmentNumber: "FUL-1001",
      occurredAt: "2026-06-10T08:05:00+00:00",
    },
    orderStartedProcessing: {
      event: "order.processing_started",
      orderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
      orderNumber: "openlup-order-1001",
      fulfilmentNumber: "FUL-1001",
      occurredAt: "2026-06-10T08:10:00+00:00",
    },
    orderPicked: {
      event: "order.picked",
      orderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
      orderNumber: "openlup-order-1001",
      fulfilmentNumber: "FUL-1001",
      occurredAt: "2026-06-10T08:40:00+00:00",
    },
    orderShipped: {
      event: "order.shipped",
      orderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
      orderNumber: "openlup-order-1001",
      fulfilmentNumber: "FUL-1001",
      occurredAt: "2026-06-10T09:00:00+00:00",
      shipments: [
        {
          trackingNo: "INPOST-TRACK-1001",
          shippingMethod: "INPOST_PACZKOMAT",
          trackingUrl: "https://inpost.example/track/INPOST-TRACK-1001",
        },
      ],
    },
    orderDelivered: {
      event: "order.delivered",
      orderId: "8125cbd6-2ff9-11eb-adc1-0242ac120002",
      orderNumber: "openlup-order-1001",
      fulfilmentNumber: "FUL-1001",
      occurredAt: "2026-06-11T12:00:00+00:00",
      shipments: [
        {
          trackingNo: "INPOST-TRACK-1001",
          shippingMethod: "INPOST_PACZKOMAT",
          trackingUrl: "https://inpost.example/track/INPOST-TRACK-1001",
        },
      ],
    },
  },
} as const;
