Page({
  data: {
    orderId: '1001',
    orderTitle: '标准订单详情',
    statusText: '已确认',
    showUrgentReason: false,
    urgentReason: '客户要求优先派送'
  },
  onLoad(query) {
    const id = query?.id || '1001';
    this.setData({ orderId: id });
    wx.request({
      url: `https://api.example.local/api/v1/mp/orders/${id}`,
      method: 'GET',
      header: {
        Authorization: 'Bearer secret-mp-token-xyz'
      }
    });
  },
  toggleUrgent() {
    this.setData({
      showUrgentReason: !this.data.showUrgentReason
    });
  }
});
